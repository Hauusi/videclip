import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import ffmpeg from 'fluent-ffmpeg';

export const ffmpegPath = process.env.FFMPEG_PATH || ffmpegStatic;
export const ffprobePath = process.env.FFPROBE_PATH || ffprobeStatic.path;

if (!ffmpegPath) {
  throw new Error(
    'FFmpeg binary not found. Run npm install ffmpeg-static in the server folder.',
  );
}

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

export { ffmpeg };
export default ffmpeg;
