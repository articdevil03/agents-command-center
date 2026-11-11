// node:test custom reporter for the mutation sweep: one JSON line per failing test, per finished file and a last summary line. run.mjs is the only reader.
const MESSAGE_LINES = 5;

const firstLines = (text) => String(text ?? "").split("\n").slice(0, MESSAGE_LINES).join("\n");
const line = (record) => `${JSON.stringify(record)}\n`;

// The real error sits one level down: details.error is node's wrapper (code ERR_TEST_FAILURE), its .cause is what the test threw.
function describeFailure(data) {
  const error = data.details?.error;
  const cause = error?.cause;
  return {
    type: "fail", file: data.file, name: data.name,
    cause: cause?.code ?? error?.code ?? cause?.constructor?.name ?? "unknown",
    message: firstLines(cause?.message ?? error?.message),
  };
}

export default async function* sweepReporter(source) {
  for await (const { type, data } of source) {
    // A suite that fails only because a test inside it failed repeats that failure; the inner test already carries the real cause.
    if (type === "test:fail" && data.details?.error?.failureType !== "subtestsFailed") yield line(describeFailure(data));
    // Under process isolation each file ends with its own test:summary (it carries the file and duration_ms); the one without a file is the run total.
    else if (type === "test:summary" && data.file) yield line({ type: "file", file: data.file, ms: data.duration_ms });
    else if (type === "test:summary") yield line({ type: "summary", pass: data.counts.passed, fail: data.counts.failed, skipped: data.counts.skipped });
  }
}
