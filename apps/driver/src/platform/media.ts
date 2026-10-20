import { Directory, File, Paths } from "expo-file-system";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";

import { ApiError } from "../core/api";
import type { FileUploader } from "../core/field-endpoints";
import type { MediaItem } from "../core/outbox";

/**
 * Proof-of-delivery files on the device.
 *
 * ⚠️ RE-ENCODED, NEVER SENT AS SHOT. A camera JPEG carries EXIF: the phone
 * model, the time and often the GPS fix of the recipient's door. The server
 * refuses any upload that still has EXIF or XMP (docs/07 §7.1), so every photo
 * is re-encoded here, which writes a fresh JPEG with no metadata, and scaled
 * to 1280 px (enough to read a label or a face at the door; ~200 KB on 3G).
 *
 * Kept in the app's DOCUMENT directory, not the cache: Android may empty the
 * cache under storage pressure, and a photo waiting for signal is evidence.
 * Deleted once the server holds it.
 */
const PHOTO_WIDTH = 1280;
const PHOTO_QUALITY = 0.7;

function podDirectory(): Directory {
  const dir = new Directory(Paths.document, "pod");
  if (!dir.exists) {
    dir.create({ intermediates: true });
  }
  return dir;
}

export interface StoredFile {
  readonly uri: string;
  readonly sizeBytes: number;
  readonly contentType: "image/jpeg" | "image/png";
}

/** A camera shot → a metadata-free JPEG in durable storage. */
export async function storePhoto(sourceUri: string, id: string): Promise<StoredFile> {
  const rendered = await ImageManipulator.manipulate(sourceUri)
    .resize({ width: PHOTO_WIDTH })
    .renderAsync();
  const saved = await rendered.saveAsync({ compress: PHOTO_QUALITY, format: SaveFormat.JPEG });
  return keep(saved.uri, `${id}.jpg`, "image/jpeg", [sourceUri]);
}

/** A captured signature PNG → durable storage. */
export function storeSignature(sourceUri: string, id: string): StoredFile {
  return keep(sourceUri, `${id}.png`, "image/png", []);
}

function keep(
  uri: string,
  name: string,
  contentType: StoredFile["contentType"],
  alsoDelete: readonly string[],
): StoredFile {
  const source = new File(uri);
  const target = new File(podDirectory(), name);
  if (target.exists) {
    target.delete();
  }
  source.moveSync(target);
  for (const extra of alsoDelete) {
    const leftover = new File(extra);
    if (leftover.exists) leftover.delete();
  }
  return { uri: target.uri, sizeBytes: target.size, contentType };
}

/** Removes a file the driver retook or abandoned before it was ever queued. */
export function discardLocal(uri: string): void {
  const file = new File(uri);
  if (file.exists) file.delete();
}

/** Upload timeout: a 300 KB photo on a poor 3G link, with room to spare. */
const UPLOAD_TIMEOUT_MS = 90_000;

/**
 * The outbox's file port: a native streaming PUT (the file is read from disk
 * by the OS, never loaded into JS memory) with the signed headers verbatim.
 */
export const fileUploader: FileUploader = {
  async put(media: MediaItem, url: string, headers: Readonly<Record<string, string>>) {
    const file = new File(media.uri);
    if (!file.exists) {
      // The evidence is gone (storage wiped, app data cleared): not retryable.
      throw new ApiError(410, "POD_FILE_MISSING", "The local file no longer exists");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
    try {
      const result = await file.upload(url, {
        httpMethod: "PUT",
        headers: { ...headers },
        mimeType: media.contentType,
        signal: controller.signal,
      });
      if (result.status < 200 || result.status >= 300) {
        // 403 is an expired or mismatched signature: a fresh slot fixes it.
        throw new ApiError(
          result.status >= 500 || result.status === 403 ? 503 : result.status,
          "UPLOAD_REFUSED",
          `Storage answered ${String(result.status)}`,
        );
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(0, "NETWORK", "Upload interrupted");
    } finally {
      clearTimeout(timer);
    }
  },
  discard(media: MediaItem): Promise<void> {
    discardLocal(media.uri);
    return Promise.resolve();
  },
};
