const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { randomUUID } = require('crypto');

// Works with AWS S3 directly, or any S3-compatible provider (Cloudflare R2,
// Backblaze B2) by setting S3_ENDPOINT. Documents are private — nothing here
// is served over a public URL; every read goes through a short-lived
// presigned GET generated on demand (see getDownloadUrl below).
const s3 = process.env.S3_BUCKET
  ? new S3Client({
      region: process.env.S3_REGION || 'auto',
      endpoint: process.env.S3_ENDPOINT || undefined,
      credentials: process.env.S3_ACCESS_KEY_ID
        ? { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY }
        : undefined,
      forcePathStyle: !!process.env.S3_ENDPOINT, // needed for R2/B2/minio-style endpoints
    })
  : null;

const BUCKET = process.env.S3_BUCKET;

const DOC_TYPES = [
  'licenseFront', 'licenseBack', 'insuranceDoc', 'registrationDoc',
  'vehiclePhotoFront', 'vehiclePhotoBack', 'vehiclePhotoLeft', 'vehiclePhotoRight',
];

function isConfigured() {
  return !!s3;
}

async function getUploadUrl(driverId, docType) {
  if (!s3) throw new Error('Document storage is not configured on this server (missing S3_BUCKET).');
  if (!DOC_TYPES.includes(docType)) throw new Error(`Unknown document type: ${docType}`);

  const key = `applications/${driverId}/${docType}-${randomUUID()}`;
  const command = new PutObjectCommand({ Bucket: BUCKET, Key: key });
  const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 300 }); // 5 minutes to complete the upload
  return { uploadUrl, key };
}

/** Same presigned-upload pattern as driver documents, but for a rider's
 * profile photo — a separate namespace (riders/...) since it's a different
 * entity, not one of the DOC_TYPES enum values above. */
async function getRiderPhotoUploadUrl(riderId) {
  if (!s3) throw new Error('Document storage is not configured on this server (missing S3_BUCKET).');

  const key = `riders/${riderId}/profile-${randomUUID()}`;
  const command = new PutObjectCommand({ Bucket: BUCKET, Key: key });
  const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 300 });
  return { uploadUrl, key };
}

async function getDownloadUrl(key) {
  if (!s3 || !key) return null;
  const command = new GetObjectCommand({ Bucket: BUCKET, Key: key });
  return getSignedUrl(s3, command, { expiresIn: 300 });
}

module.exports = { isConfigured, getUploadUrl, getRiderPhotoUploadUrl, getDownloadUrl, DOC_TYPES };
