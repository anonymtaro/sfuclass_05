/**
 * apps/mobile/src/native/filePicker.ts
 * Used by ChatScreen's composer to attach files from the device (F6).
 */
import * as DocumentPicker from 'expo-document-picker';
import type { UploadFile } from '@classroom/core-client';

export async function pickChatAttachment(): Promise<UploadFile | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: '*/*',
    copyToCacheDirectory: true,
    multiple: false,
  });

  if (result.canceled || result.assets.length === 0) return null;

  const asset = result.assets[0];
  return {
    uri: asset.uri,
    name: asset.name,
    mimeType: asset.mimeType ?? 'application/octet-stream',
    sizeBytes: asset.size ?? 0,
  };
}