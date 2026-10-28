import { parsePly } from './ply.js';
self.onmessage = ({ data: { id, buffer, options } }) => {
  try {
    const model = parsePly(buffer, options);
    self.postMessage({ id, model }, [model.data.buffer, model.sh.buffer]);
  } catch (error) { self.postMessage({ id, error: error.message }); }
};
