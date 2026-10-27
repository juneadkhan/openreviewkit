import { runPipeline } from './openreviewkit-pipeline.mjs';
import { subscriptionEnvironment } from './local-review.mjs';

if (!process.env.CLAUDE_CODE_OAUTH_TOKEN)
  throw new Error('Configure subscription OAuth; there is no API-key fallback.');
const { output, stats } = await runPipeline({ env: subscriptionEnvironment() });
console.log(
  `Review complete: ${stats.finders} finders, ${stats.failed_finders.length} failed, verdict ${output?.verdict || 'unavailable'}.`
);
if (!output) process.exitCode = 1;
