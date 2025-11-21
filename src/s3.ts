import crypto from "crypto";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const REGION = process.env.AWS_REGION || "ap-southeast-2";
const BUCKET = process.env.S3_BUCKET_NAME;

if (!BUCKET) {
    // Fail fast if bucket is not configured
    throw new Error("S3_BUCKET_NAME is not set in environment variables.");
}

// Optional path prefix inside the bucket (e.g. "uploads")
const PREFIX = (process.env.S3_PREFIX || "")
    .trim()
    .replace(/^\/+|\/+$/g, "");

// Optional public URL base (e.g. CloudFront or custom domain)
// If set, uploaded keys will be appended to this instead of the raw S3 URL.
const PUBLIC_BASE = (process.env.S3_PUBLIC_URL_BASE || "")
    .trim()
    .replace(/\/+$/g, "");

// S3 client uses standard AWS credential resolution (env vars, instance role, etc.)
const s3 = new S3Client({
    region: REGION,
});

/**
 * Upload an image buffer to S3 and return a public URL.
 *
 * NOTE:
 * - We DO NOT set an ACL here, to be compatible with buckets that have
 *   ObjectOwnership = BucketOwnerEnforced (ACLs disabled).
 * - Ensure your bucket policy or CloudFront distribution allows public
 *   read access to the key prefix used here if students need to view images.
 */
export async function uploadImageToS3(opts: {
    buffer: Buffer;
    contentType: string;
    folder: string;
    extension?: string;
}): Promise<string> {
    const { buffer, contentType, folder, extension } = opts;

    const random = crypto.randomBytes(16).toString("hex");
    const safeFolder = folder.replace(/^\/+|\/+$/g, "");
    const ext = (extension || mimeToExt(contentType) || "bin")
        .replace(/^\./, "")
        .toLowerCase();

    const segments = [PREFIX, safeFolder, `${Date.now()}-${random}.${ext}`].filter(
        Boolean
    );
    const key = segments.join("/");

    await s3.send(
        new PutObjectCommand({
            Bucket: BUCKET,
            Key: key,
            Body: buffer,
            ContentType: contentType || "application/octet-stream",
            // ❌ ACL removed to avoid "The bucket does not allow ACLs"
        })
    );

    if (PUBLIC_BASE) {
        return `${PUBLIC_BASE}/${key}`;
    }

    // Default to plain S3 URL
    return `https://${BUCKET}.s3.${REGION}.amazonaws.com/${key}`;
}

function mimeToExt(mime: string): string | null {
    const m = mime.toLowerCase();
    if (m === "image/png") return "png";
    if (m === "image/jpeg" || m === "image/jpg") return "jpg";
    if (m === "image/gif") return "gif";
    if (m === "image/webp") return "webp";
    if (m === "image/svg+xml") return "svg";
    return null;
}
