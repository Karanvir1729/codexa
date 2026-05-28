import { GoogleAuth } from "google-auth-library";

const input = await new Promise((resolve, reject) => {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    data += chunk;
  });
  process.stdin.on("end", () => resolve(data));
  process.stdin.on("error", reject);
});

function firestoreString(value) {
  return encodeURIComponent(value).replace(/%2F/g, "%2F");
}

function encodeDocument(payload) {
  const index = payload?.index && typeof payload.index === "object" ? payload.index : {};
  const fields = {
    payload: { stringValue: JSON.stringify(payload.payload) },
    updated_at: { timestampValue: new Date().toISOString() },
  };
  for (const [key, value] of Object.entries(index)) {
    fields[key] = encodeValue(value);
  }
  return { fields };
}

function encodeValue(value) {
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encodeValue) } };
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number" && Number.isInteger(value)) return { integerValue: String(value) };
  if (typeof value === "number") return { doubleValue: value };
  return { stringValue: String(value) };
}

function filterOp(op) {
  return op === "in" ? "IN" : "EQUAL";
}

function structuredWhere(filters) {
  const fieldFilters = (filters ?? []).map((filter) => ({
    fieldFilter: {
      field: { fieldPath: filter.field },
      op: filterOp(filter.op),
      value: encodeValue(filter.value),
    },
  }));
  if (!fieldFilters.length) return undefined;
  if (fieldFilters.length === 1) return fieldFilters[0];
  return {
    compositeFilter: {
      op: "AND",
      filters: fieldFilters,
    },
  };
}

function decodeDocument(document) {
  const raw = document?.fields?.payload?.stringValue;
  return raw ? JSON.parse(raw) : null;
}

async function firestoreFetch(request, path, init = {}) {
  const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/datastore"] });
  const client = await auth.getClient();
  const rawHeaders = await client.getRequestHeaders();
  const headers = typeof rawHeaders.entries === "function" ? Object.fromEntries(rawHeaders.entries()) : rawHeaders;
  const separator = path.startsWith(":") ? "" : "/";
  const url = `https://firestore.googleapis.com/v1/projects/${firestoreString(request.projectId)}/databases/${firestoreString(request.databaseId)}/documents${separator}${path}`;
  const response = await fetch(url, {
    ...init,
    headers: {
      ...headers,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (response.status === 404 && (request.op === "get" || request.op === "delete")) return null;
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${request.op} ${path} failed with ${response.status}: ${text.slice(0, 1000)}`);
  }
  return text ? JSON.parse(text) : null;
}

async function listDocuments(request) {
  const values = [];
  let pageToken = "";
  const limit = Number(request.limit || 300);
  do {
    const remaining = Math.max(1, limit - values.length);
    const pageSize = Math.min(300, remaining);
    const suffix = pageToken ? `?pageSize=${pageSize}&pageToken=${encodeURIComponent(pageToken)}` : `?pageSize=${pageSize}`;
    const payload = await firestoreFetch(request, `${firestoreString(request.collection)}${suffix}`, { method: "GET" });
    for (const document of payload?.documents ?? []) {
      const decoded = decodeDocument(document);
      if (decoded) values.push(decoded);
      if (values.length >= limit) break;
    }
    pageToken = payload?.nextPageToken ?? "";
  } while (pageToken && values.length < limit);
  return values;
}

async function queryDocuments(request) {
  const where = structuredWhere(request.filters ?? []);
  const body = {
    structuredQuery: {
      from: [{ collectionId: request.collection }],
      ...(where ? { where } : {}),
      limit: Number(request.limit || 100),
    },
  };
  const payload = await firestoreFetch(request, ":runQuery", { method: "POST", body: JSON.stringify(body) });
  const values = [];
  for (const item of payload ?? []) {
    const decoded = decodeDocument(item.document);
    if (decoded) values.push(decoded);
  }
  return values;
}

try {
  const request = JSON.parse(input);
  if (request.op === "get") {
    const document = await firestoreFetch(request, `${firestoreString(request.collection)}/${firestoreString(request.documentId)}`, { method: "GET" });
    process.stdout.write(JSON.stringify(document ? decodeDocument(document) : null));
  } else if (request.op === "put") {
    const indexFieldMasks = Object.keys(request.index ?? {}).map((key) => `updateMask.fieldPaths=${encodeURIComponent(key)}`);
    const updateMask = ["updateMask.fieldPaths=payload", "updateMask.fieldPaths=updated_at", ...indexFieldMasks].join("&");
    const document = await firestoreFetch(
      request,
      `${firestoreString(request.collection)}/${firestoreString(request.documentId)}?${updateMask}`,
      { method: "PATCH", body: JSON.stringify(encodeDocument({ payload: request.payload, index: request.index })) },
    );
    process.stdout.write(JSON.stringify(decodeDocument(document)));
  } else if (request.op === "list") {
    process.stdout.write(JSON.stringify(await listDocuments(request)));
  } else if (request.op === "query") {
    process.stdout.write(JSON.stringify(await queryDocuments(request)));
  } else if (request.op === "delete") {
    await firestoreFetch(request, `${firestoreString(request.collection)}/${firestoreString(request.documentId)}`, { method: "DELETE" });
    process.stdout.write("null");
  } else {
    throw new Error(`Unsupported Firestore state op: ${request.op}`);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
