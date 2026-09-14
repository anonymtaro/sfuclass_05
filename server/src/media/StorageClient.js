// classroom-app/server/src/media/StorageClient.js
/**
 * Object storage  (F4)  [NEW]
 *
 * The only file that imports the S3 SDK. Everything else in the platform talks
 * to these functions, which is what lets MinIO stand in locally and what keeps
 * bucket names out of the domain code.
 *
 * The three buckets are a security boundary, not filing:
 *
 *   raw          presigned upload target. Nothing is ever served from here.
 *   quarantine   holds an object until the scan clears it. No CDN origin.
 *   delivery     scanned and processed. The only bucket CloudFront can read.
 *
 * `promote` is the move between them, and it is deliberately a copy-then-delete
 * rather than a rename: S3 has no rename, and a failed copy that has already
 * deleted the source is an unrecoverable loss of somebody's lecture.
 */

import { buckets, s3ClientOptions, multipart } from '../config/storage.config.js';
import { logger } from '../observability/logger.js';

const log = logger.child({ component: 'storage' });

let client = null;
let presigner = null;

/** Lazy, so a process that never touches storage never loads the SDK. */
const getClient = async () => {
  if (client) return client;
  const { S3Client } = await import('@aws-sdk/client-s3');
  client = new S3Client(s3ClientOptions);
  return client;
};

const getPresigner = async () => {
  if (presigner) return presigner;
  const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
  presigner = getSignedUrl;
  return presigner;
};

const bucketName = (alias) => buckets[alias] ?? alias;

// ---------------------------------------------------------------------------
// Multipart upload
// ---------------------------------------------------------------------------

/**
 * Starts a multipart upload and presigns every part URL up front.
 *
 * Presigning all of them at once costs one round trip instead of one per part;
 * the cost is that a slow upload can outlive the signatures, which is why
 * `multipart.urlTtlSec` is an hour and why `refreshPartUrls` exists.
 */
export const createMultipartUpload = async ({ bucket = 'raw', key, contentType, parts, partSize, checksum }) => {
  const { CreateMultipartUploadCommand, UploadPartCommand } = await import('@aws-sdk/client-s3');
  const s3 = await getClient();
  const sign = await getPresigner();

  const created = await s3.send(
    new CreateMultipartUploadCommand({
      Bucket: bucketName(bucket),
      Key: key,
      ContentType: contentType,
      // Stored on the object so an integrity check after the fact does not
      // need the database.
      Metadata: checksum ? { checksum } : undefined,
    }),
  );

  const urls = await Promise.all(
    Array.from({ length: parts }, (_unused, index) =>
      sign(
        s3,
        new UploadPartCommand({
          Bucket: bucketName(bucket),
          Key: key,
          UploadId: created.UploadId,
          PartNumber: index + 1,
        }),
        { expiresIn: multipart.urlTtlSec },
      ),
    ),
  );

  return {
    uploadId: created.UploadId,
    parts: urls.map((url, index) => ({
      partNumber: index + 1,
      url,
      offset: index * partSize,
      size: partSize,
    })),
  };
};

/** For an upload that outlived its signatures. */
export const refreshPartUrls = async ({ bucket = 'raw', key, uploadId, partNumbers, partSize }) => {
  const { UploadPartCommand } = await import('@aws-sdk/client-s3');
  const s3 = await getClient();
  const sign = await getPresigner();

  return Promise.all(
    partNumbers.map(async (partNumber) => ({
      partNumber,
      url: await sign(
        s3,
        new UploadPartCommand({ Bucket: bucketName(bucket), Key: key, UploadId: uploadId, PartNumber: partNumber }),
        { expiresIn: multipart.urlTtlSec },
      ),
      offset: (partNumber - 1) * partSize,
      size: partSize,
    })),
  );
};

export const completeMultipartUpload = async ({ bucket = 'raw', key, uploadId, parts }) => {
  const { CompleteMultipartUploadCommand } = await import('@aws-sdk/client-s3');
  const s3 = await getClient();

  const result = await s3.send(
    new CompleteMultipartUploadCommand({
      Bucket: bucketName(bucket),
      Key: key,
      UploadId: uploadId,
      MultipartUpload: {
        // S3 rejects out-of-order parts, and a client uploading in parallel
        // reports them in whatever order they finished.
        Parts: [...parts]
          .sort((a, b) => a.partNumber - b.partNumber)
          .map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })),
      },
    }),
  );

  return { etag: result.ETag, location: result.Location };
};

export const abortMultipartUpload = async ({ bucket = 'raw', key, uploadId }) => {
  const { AbortMultipartUploadCommand } = await import('@aws-sdk/client-s3');
  const s3 = await getClient();
  await s3
    .send(new AbortMultipartUploadCommand({ Bucket: bucketName(bucket), Key: key, UploadId: uploadId }))
    .catch((cause) => log.warn({ err: cause, key }, 'abort failed; the lifecycle rule will reap it'));
};

/** Which parts S3 already holds, so a resumed upload skips them. */
export const listUploadedParts = async ({ bucket = 'raw', key, uploadId }) => {
  const { ListPartsCommand } = await import('@aws-sdk/client-s3');
  const s3 = await getClient();

  const result = await s3.send(
    new ListPartsCommand({ Bucket: bucketName(bucket), Key: key, UploadId: uploadId }),
  );
  return (result.Parts ?? []).map((part) => part.PartNumber);
};

// ---------------------------------------------------------------------------
// Objects
// ---------------------------------------------------------------------------

/** Server-side upload, for recordings and generated PDFs. */
export const putObject = async ({ bucket = 'raw', key, body, contentType, metadata = {} }) => {
  const { PutObjectCommand } = await import('@aws-sdk/client-s3');
  const s3 = await getClient();

  await s3.send(
    new PutObjectCommand({
      Bucket: bucketName(bucket),
      Key: key,
      Body: body,
      ContentType: contentType,
      Metadata: metadata,
    }),
  );

  return { bucket, key, sizeBytes: body.length ?? body.byteLength ?? 0 };
};

export const getObjectStream = async ({ bucket, key }) => {
  const { GetObjectCommand } = await import('@aws-sdk/client-s3');
  const s3 = await getClient();
  const result = await s3.send(new GetObjectCommand({ Bucket: bucketName(bucket), Key: key }));
  return result.Body;
};

export const headObject = async ({ bucket, key }) => {
  const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
  const s3 = await getClient();

  try {
    const result = await s3.send(new HeadObjectCommand({ Bucket: bucketName(bucket), Key: key }));
    return {
      sizeBytes: result.ContentLength,
      contentType: result.ContentType,
      etag: result.ETag,
      checksum: result.Metadata?.checksum ?? null,
    };
  } catch (cause) {
    if (cause?.name === 'NotFound') return null;
    throw cause;
  }
};

export const deleteObject = async ({ bucket, key }) => {
  const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
  const s3 = await getClient();
  await s3.send(new DeleteObjectCommand({ Bucket: bucketName(bucket), Key: key }));
};

/**
 * Moves an object between buckets. Copy first, verify, then delete — in that
 * order, so a failure at any point leaves the bytes somewhere rather than
 * nowhere.
 */
export const promote = async ({ fromBucket, toBucket, key, toKey = null }) => {
  const { CopyObjectCommand } = await import('@aws-sdk/client-s3');
  const s3 = await getClient();
  const destination = toKey ?? key;

  await s3.send(
    new CopyObjectCommand({
      Bucket: bucketName(toBucket),
      Key: destination,
      CopySource: `${bucketName(fromBucket)}/${encodeURIComponent(key)}`,
      MetadataDirective: 'COPY',
    }),
  );

  const copied = await headObject({ bucket: toBucket, key: destination });
  if (!copied) {
    throw new Error(`copy to ${toBucket}/${destination} reported success but the object is missing`);
  }

  await deleteObject({ bucket: fromBucket, key });

  log.debug({ fromBucket, toBucket, key: destination }, 'object promoted');
  return { bucket: toBucket, key: destination, sizeBytes: copied.sizeBytes };
};

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

/**
 * Readiness probe. HeadBucket, not a listing: it proves reachability and
 * permission without paying for a list on a bucket with a million objects.
 * Called by lifecycle/readiness.js.
 */
export const headDeliveryBucket = async () => {
  const { HeadBucketCommand } = await import('@aws-sdk/client-s3');
  const s3 = await getClient();
  await s3.send(new HeadBucketCommand({ Bucket: buckets.delivery }));
  return true;
};

/** Tests only. */
export const resetStorageClient = () => {
  client = null;
  presigner = null;
};

export default {
  createMultipartUpload, completeMultipartUpload, abortMultipartUpload, listUploadedParts,
  putObject, getObjectStream, headObject, deleteObject, promote, headDeliveryBucket,
};