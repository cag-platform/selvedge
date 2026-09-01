import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export type VisualObjectStore = {
  put(key: string, bytes: Uint8Array, mime: string): Promise<void>;
  signedGet(key: string): Promise<string>;
  delete(key: string): Promise<void>;
};

export function visualObjectStore(env: NodeJS.ProcessEnv = process.env): VisualObjectStore | null {
  const bucket = env.VISUAL_ASSET_BUCKET?.trim();
  if (!bucket) return null;
  const client = new S3Client({
    region: env.VISUAL_ASSET_REGION?.trim() || 'auto',
    ...(env.VISUAL_ASSET_ENDPOINT ? { endpoint: env.VISUAL_ASSET_ENDPOINT, forcePathStyle: env.VISUAL_ASSET_FORCE_PATH_STYLE === 'true' } : {}),
    ...(env.VISUAL_ASSET_ACCESS_KEY_ID && env.VISUAL_ASSET_SECRET_ACCESS_KEY
      ? { credentials: { accessKeyId: env.VISUAL_ASSET_ACCESS_KEY_ID, secretAccessKey: env.VISUAL_ASSET_SECRET_ACCESS_KEY } }
      : {}),
  });
  return {
    async put(key, bytes, mime) {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: mime }));
    },
    async signedGet(key) {
      return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 300 });
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}

export function visualStorageKey(orgId: string, visualId: string, mime: string): string {
  const extension = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';
  return `generated/${encodeURIComponent(orgId)}/${visualId}.${extension}`;
}

export function migrationEvidenceStorageKey(orgId: string, artifactId: string): string {
  return `migration-evidence/${encodeURIComponent(orgId)}/${encodeURIComponent(artifactId)}.png`;
}

export function previewEvidenceStorageKey(orgId: string, projectId: string, artifactId: string): string {
  return `preview-evidence/${encodeURIComponent(orgId)}/${encodeURIComponent(projectId)}/${encodeURIComponent(artifactId)}.png`;
}
