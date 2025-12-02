export const DOCUMENT_TYPES = ['pdf', 'docx', 'txt', 'xlsx', 'xls'];
export const IMAGE_TYPES = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'];

export type FileType = 'document' | 'image' | 'other';

export function getFileType(fileExtension: string): FileType {
  const ext = fileExtension.toLowerCase();
  
  if (DOCUMENT_TYPES.includes(ext)) {
    return 'document';
  }
  
  if (IMAGE_TYPES.includes(ext)) {
    return 'image';
  }
  
  return 'other';
}

export function isDocument(fileExtension: string): boolean {
  return DOCUMENT_TYPES.includes(fileExtension.toLowerCase());
}

export function isImage(fileExtension: string): boolean {
  return IMAGE_TYPES.includes(fileExtension.toLowerCase());
}

