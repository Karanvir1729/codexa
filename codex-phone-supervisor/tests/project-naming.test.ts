import test from "node:test";
import assert from "node:assert/strict";
import { slugifyProjectName, titleFromSlug } from "../backend/src/project-naming.js";

test("project naming only sanitizes model-provided names", () => {
  assert.equal(slugifyProjectName(' "Jk" '), "jk");
  assert.equal(slugifyProjectName("Selling Seasonal Dumplings Website"), "selling-seasonal-dumplings-website");
  assert.equal(titleFromSlug("selling-seasonal-dumplings-website"), "Selling Seasonal Dumplings Website");
});

test("slugify rejects names without letters or numbers", () => {
  assert.throws(() => slugifyProjectName("!!!"), /Project name must include at least one letter or number/);
});
