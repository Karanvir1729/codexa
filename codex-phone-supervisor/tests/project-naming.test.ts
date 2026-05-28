import test from "node:test";
import assert from "node:assert/strict";
import { inferNewProjectSpec, slugifyProjectName } from "../backend/src/project-naming.js";

test("new website requests infer a repo-local project slug", () => {
  const spec = inferNewProjectSpec("can you build a website that talks about chairs");
  assert.equal(spec?.needsName, false);
  assert.equal(spec?.displayName, "Chairs Website");
  assert.equal(spec?.slug, "chairs-website");
});

test("commerce website requests infer the product being sold", () => {
  const spec = inferNewProjectSpec("make a website for selling seasonal dumplings");
  assert.equal(spec?.needsName, false);
  assert.equal(spec?.displayName, "Selling Seasonal Dumplings Website");
  assert.equal(spec?.slug, "selling-seasonal-dumplings-website");
});

test("natural app requests infer the app and purpose", () => {
  const spec = inferNewProjectSpec("I need a calorie calculator app for trail snacks");
  assert.equal(spec?.needsName, false);
  assert.equal(spec?.displayName, "Calorie Calculator For Trail Snacks App");
  assert.equal(spec?.slug, "calorie-calculator-for-trail-snacks-app");
});

test("quoted new project names are preserved and normalized", () => {
  const spec = inferNewProjectSpec('build a new agent called "chair website"');
  assert.equal(spec?.needsName, false);
  assert.equal(spec?.displayName, "Chair Website");
  assert.equal(spec?.slug, "chair-website");
});

test("vague new project requests ask for a name", () => {
  const spec = inferNewProjectSpec("build a new project");
  assert.equal(spec?.needsName, true);
  assert.equal(spec?.assistantMessage, "What should I call the new project?");
});

test("vague game requests ask for a name", () => {
  const spec = inferNewProjectSpec("build a game");
  assert.equal(spec?.needsName, true);
  assert.equal(spec?.displayName, "");
});

test("vague new project requests do not reuse stale project names", () => {
  const spec = inferNewProjectSpec("build a new website", [
    { role: "user", text: "can you build a website that talks about armchairs", ts: new Date().toISOString() },
  ]);
  assert.equal(spec?.needsName, true);
  assert.equal(spec?.displayName, "");
});

test("slugify rejects names without letters or numbers", () => {
  assert.throws(() => slugifyProjectName("!!!"), /Project name must include at least one letter or number/);
});
