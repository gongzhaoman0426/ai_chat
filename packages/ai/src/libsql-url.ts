import { pathToFileURL } from 'node:url';

export function mastraFileUrl(filePath: string, windows = process.platform === 'win32') {
  const url = pathToFileURL(filePath, { windows }).href;
  // Mastra 1.22's vector write lock strips only "file:" before calling realpath.
  // On Windows, ///C:/... resolves to C:\C:\... . LibSQL accepts file:C:/...;
  // keep URL escaping so spaces, Chinese characters, # and % still round-trip.
  return windows ? url.replace(/^file:\/\/\/([a-z]:\/)/i, 'file:$1') : url;
}
