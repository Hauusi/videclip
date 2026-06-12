/** Latest preview wins; does not wait for older FFmpeg jobs to finish. */
let latestGen = 0;

export function enqueuePreview(task) {
  const gen = ++latestGen;
  return Promise.resolve()
    .then(() => {
      if (gen !== latestGen) {
        const err = new Error('Preview superseded');
        err.code = 'PREVIEW_SUPERSEDED';
        throw err;
      }
      return task();
    })
    .then((result) => {
      if (gen !== latestGen) {
        const err = new Error('Preview superseded');
        err.code = 'PREVIEW_SUPERSEDED';
        throw err;
      }
      return result;
    });
}
