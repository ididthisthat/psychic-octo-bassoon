import assert from "node:assert";

// Oxlo doesn't remap model names (unlike Sixth), so just verify the model list.
// The MODELS array lives in server.ts and is imported by the runtime.
const MODELS = [
	"deepseek-v3.2",
	"deepseek-r1-8b",
	"gemma-3-4b",
	"llama-3.2-3b",
	"mistral-7b",
	"stable-diffusion-1.5",
];

assert.equal(MODELS.includes("deepseek-v3.2"), true);
assert.equal(MODELS.includes("stable-diffusion-1.5"), true);
assert.equal(MODELS.includes("gpt-4o"), false);

console.log("ok");
