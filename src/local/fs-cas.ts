/**
 * Filesystem-backed Content-Addressable Storage.
 *
 * Stores artifacts by BLAKE3 hash on the local filesystem.
 * Layout: {root}/{hash[0:2]}/{hash[2:4]}/{hash}
 *
 * TODO: Implement in #9
 */

import type { ContentStore } from "../core/cas.js";

export class FsCas implements ContentStore {
  readonly rootPath: string;

  constructor(rootPath: string) {
    this.rootPath = rootPath;
  }

  put = async (_data: Uint8Array): Promise<string> => {
    throw new Error("Not implemented");
  };

  get = async (_contentHash: string): Promise<Uint8Array | undefined> => {
    throw new Error("Not implemented");
  };

  exists = async (_contentHash: string): Promise<boolean> => {
    throw new Error("Not implemented");
  };

  delete = async (_contentHash: string): Promise<boolean> => {
    throw new Error("Not implemented");
  };

  putFile = async (_path: string): Promise<string> => {
    throw new Error("Not implemented");
  };

  getToFile = async (_contentHash: string, _path: string): Promise<boolean> => {
    throw new Error("Not implemented");
  };
}
