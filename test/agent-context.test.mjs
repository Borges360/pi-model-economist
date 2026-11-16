import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("context keeps model dispatch and offline evaluation boundaries explicit", async () => {
  const agents = await read("../AGENTS.md");
  const skill = await read("../.agents/skills/pi-model-economist/SKILL.md");

  assert.match(agents, /Pi dispatches the chosen\s+model/);
  assert.match(skill, /does not answer\s+tasks,\s+call a model to simulate/);
  assert.match(skill, /Missing prices and measurements stay unknown/);
  assert.match(skill, /replays\s+an existing measured matrix offline/);
  assert.match(skill, /No INTEIRO design-system role is selected/);
});

test("Pi and Cursor specialization and metadata are identical", async () => {
  const [piSkill, cursorSkill, piMetadata, cursorMetadata] = await Promise.all([
    read("../.agents/skills/pi-model-economist/SKILL.md"),
    read("../.cursor/skills/pi-model-economist/SKILL.md"),
    read("../.agents/skills/pi-model-economist/metadata.yaml"),
    read("../.cursor/skills/pi-model-economist/metadata.yaml"),
  ]);

  assert.equal(piSkill, cursorSkill);
  assert.equal(piMetadata, cursorMetadata);
  assert.match(piMetadata, /id: pi-model-economist/);
  assert.match(piMetadata, /owner: pi-model-economist/);
});
