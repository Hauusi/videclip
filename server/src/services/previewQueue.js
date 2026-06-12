/** One preview render at a time — avoids parallel FFmpeg overload. */
let chain = Promise.resolve();

export function enqueueServerPreview(task) {
  const run = chain.then(() => task()).catch((err) => {
    throw err;
  });
  chain = run.catch(() => {});
  return run;
}
