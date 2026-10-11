// The smallest useful request to the Claude Messages API.
//   ANTHROPIC_API_KEY=... node quickstart.ts "Your question here"
// The SDK also picks up ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile,
// so never hardcode a key in this file.
import Anthropic from "@anthropic-ai/sdk";

const question = process.argv.slice(2).join(" ") || "In two sentences, what is the Claude Messages API?";

const client = new Anthropic();

try {
  // beta.messages: needed only for `fallbacks`. If Claude Opus 5.5's safety
  // classifiers decline the request, the API re-runs it on the model Anthropic
  // recommends for that refusal category, inside this same call.
  const response = await client.beta.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 16000,
    // Claude Opus 5.5 always thinks; effort sets how hard (its default is "medium").
    output_config: { effort: "medium" },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    messages: [{ role: "user", content: question }],
  });

  // Check why the model stopped before reading the content.
  if (response.stop_reason === "refusal") {
    console.error(`Declined (${response.stop_details?.category ?? "no category"}): ${response.stop_details?.explanation ?? ""}`);
    process.exit(1);
  }
  for (const block of response.content) {
    if (block.type === "text") console.log(block.text);
  }
  if (response.stop_reason === "max_tokens") console.error("\n[cut off at max_tokens]");

  const u = response.usage;
  console.error(`\nmodel ${response.model} · ${u.input_tokens} input + ${u.output_tokens} output tokens · stop: ${response.stop_reason}`);
} catch (error) {
  // Most specific first. The SDK already retries 429s, 5xx, and connection errors twice.
  if (error instanceof Anthropic.AuthenticationError) {
    console.error("No valid credentials. Set ANTHROPIC_API_KEY (from platform.claude.com) or run `ant auth login`.");
  } else if (error instanceof Anthropic.PermissionDeniedError) {
    console.error(`This key may not use this model or feature: ${error.message}`);
  } else if (error instanceof Anthropic.RateLimitError) {
    console.error("Rate limited. Wait a moment and try again.");
  } else if (error instanceof Anthropic.BadRequestError) {
    console.error(`Bad request: ${error.message}`);
  } else if (error instanceof Anthropic.APIError) {
    console.error(`API error ${error.status}: ${error.message}`);
  } else {
    // Raised before any request is sent, e.g. when no credentials are configured.
    console.error(`${(error as Error).message}\nSet ANTHROPIC_API_KEY (from platform.claude.com) or run \`ant auth login\`.`);
  }
  process.exit(1);
}
