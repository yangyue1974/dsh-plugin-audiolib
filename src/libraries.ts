/**
 * The AudioLib catalog as published at https://audiolib.ai/libraries.
 *
 * The list is advisory, not a closed set: `music_play` accepts any id so a
 * library added after this release still works, and the API answers
 * `LIBRARY_NOT_FOUND` for one that does not exist.
 */
export const LIBRARIES: readonly string[] = [
  // Recommended
  'audio.default',
  'audio.focus',
  'audio.relax',
  'audio.sleep',
  'audio.background',
  'audio.workout',
  'audio.energy',
  // Functional
  'audio.study',
  'audio.running',
  'audio.healing',
  'audio.meditation',
  'audio.emotional',
  'audio.flow',
  'audio.ambient',
  // Style
  'audio.house',
  'audio.pop',
  'audio.rock',
  'audio.electronic',
  'audio.disco',
  'audio.trance',
  'audio.techno',
  'audio.dubstep',
  'audio.jazz',
  'audio.classical',
  'audio.cinematic',
]
