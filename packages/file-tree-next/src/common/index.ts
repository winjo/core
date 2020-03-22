import { URI, BasicEvent } from '@ali/ide-core-common';
import { ITree, ITreeNode } from '@ali/ide-components';
import { FileStat } from '@ali/ide-file-service';
import { Directory, File } from '../browser/file-tree-nodes';

export const IFileTreeAPI = Symbol('IFileTreeAPI');

export interface IFileTreeAPI {
  create(newUri: URI);
  mvFiles(oldUri: URI[], newUri: URI, isDirectory?: boolean): Promise<boolean>;
  mv(oldUri: URI , newUri: URI, isDirectory?: boolean): Promise<boolean>;
  resolveChildren(tree: ITree, path: string | FileStat, parent?: Directory): Promise<(File | Directory)[]>;
}

export class FileTreeExpandedStatusUpdateEvent extends BasicEvent<{uri: URI, expanded: boolean}> {}

export interface FileStatNode extends ITreeNode {
  uri: URI;
  filestat: FileStat;
}

export namespace FileStatNode {
  export function is(node: object | undefined): node is FileStatNode {
    return !!node && 'filestat' in node;
  }
  export function isContentFile(node: any | undefined): node is FileStatNode {
    return !!node && 'filestat' in node && !node.fileStat.isDirectory;
  }

  export function getUri(node: ITreeNode | undefined): string | undefined {
    if (is(node)) {
      return node.filestat.uri;
    }
    return undefined;
  }
}
