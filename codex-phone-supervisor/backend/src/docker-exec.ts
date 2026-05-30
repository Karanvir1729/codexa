import http from "node:http";

export interface DockerExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function dockerSocketPath() {
  return process.env.DOCKER_HOST?.startsWith("unix://")
    ? process.env.DOCKER_HOST.slice("unix://".length)
    : process.env.HEAD_DEVELOPER_DOCKER_SOCKET || "/var/run/docker.sock";
}

function requestDocker(path: string, init: { method?: string; body?: unknown; timeout_ms?: number } = {}) {
  const body = init.body === undefined ? undefined : JSON.stringify(init.body);
  return new Promise<{ statusCode: number; body: Buffer }>((resolve, reject) => {
    const req = http.request({
      socketPath: dockerSocketPath(),
      path,
      method: init.method ?? "GET",
      headers: body
        ? {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          }
        : undefined,
      timeout: init.timeout_ms,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
    });
    req.on("timeout", () => {
      req.destroy(new Error(`Docker API request timed out after ${init.timeout_ms}ms.`));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function parseJson<T>(response: { statusCode: number; body: Buffer }, operation: string): T {
  const text = response.body.toString("utf8");
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`${operation} failed with Docker API status ${response.statusCode}: ${text.slice(0, 500)}`);
  }
  return JSON.parse(text) as T;
}

function demuxDockerStream(buffer: Buffer) {
  let offset = 0;
  let stdout = "";
  let stderr = "";
  while (offset + 8 <= buffer.length) {
    const streamType = buffer[offset];
    const length = buffer.readUInt32BE(offset + 4);
    const start = offset + 8;
    const end = start + length;
    if (end > buffer.length) break;
    const text = buffer.subarray(start, end).toString("utf8");
    if (streamType === 2) stderr += text;
    else stdout += text;
    offset = end;
  }
  if (offset === 0 && buffer.length) stdout = buffer.toString("utf8");
  return { stdout, stderr };
}

export async function dockerExec(input: {
  containerId: string;
  command: string;
  args: string[];
  cwd: string;
  timeout_ms?: number;
}): Promise<DockerExecResult> {
  const timeoutMs = input.timeout_ms ?? 120_000;
  const created = parseJson<{ Id: string }>(await requestDocker(`/containers/${encodeURIComponent(input.containerId)}/exec`, {
    method: "POST",
    timeout_ms: 30_000,
    body: {
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      WorkingDir: input.cwd,
      Cmd: [input.command, ...input.args],
      Env: ["NO_COLOR=1", "FORCE_COLOR=0"],
    },
  }), "Docker exec create");

  const output = await requestDocker(`/exec/${encodeURIComponent(created.Id)}/start`, {
    method: "POST",
    timeout_ms: timeoutMs,
    body: { Detach: false, Tty: false },
  });
  if (output.statusCode < 200 || output.statusCode >= 300) {
    throw new Error(`Docker exec start failed with Docker API status ${output.statusCode}: ${output.body.toString("utf8").slice(0, 500)}`);
  }
  const inspect = parseJson<{ ExitCode: number | null }>(await requestDocker(`/exec/${encodeURIComponent(created.Id)}/json`, {
    timeout_ms: 30_000,
  }), "Docker exec inspect");
  const streams = demuxDockerStream(output.body);
  return { code: inspect.ExitCode, stdout: streams.stdout, stderr: streams.stderr };
}
