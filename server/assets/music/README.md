# Preset background music (royalty-free)

Add MP3 files here — clips export without music if files are missing.

**Any `.mp3` filename works** (e.g. `my-beat.mp3`). Optional canonical names: `track1.mp3` … `track3.mp3` for three variants per mood.

## Folder layout

- `hype/` — at least one `.mp3` (or `track1.mp3`, `track2.mp3`, `track3.mp3`)
- `chill/track1.mp3`, `track2.mp3`, `track3.mp3`
- `emotional/track1.mp3`, `track2.mp3`, `track3.mp3`

## Free sources (check license per track)

- [YouTube Audio Library](https://studio.youtube.com/channel/UC/music)
- [Pixabay Music](https://pixabay.com/music/)
- [Free Music Archive](https://freemusicarchive.org/)

## Behaviour in Videclip

- **Auto**: picks a track per clip from mood + viral score (deterministic).
- **Hook**: no background music — only original voice; music starts after the hook via FFmpeg `adelay`.
- **Volume**: UI slider 0–40% (stored as `musicVolume` in render settings).
