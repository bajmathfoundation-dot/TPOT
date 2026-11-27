const Busboy = require('busboy');

// Configuration pulled from Vercel Environment Variables
const GH = {
  owner:  process.env.GITHUB_OWNER,   // e.g., "bajmathfoundation-dot"
  repo:   process.env.GITHUB_REPO,    // e.g., "TPOT-images"
  branch: process.env.GITHUB_BRANCH || 'main',
  folder: process.env.GITHUB_FOLDER || 'dishes',
  token:  process.env.GITHUB_TOKEN    // The secret PAT
};

const RAW_BASE = `https://raw.githubusercontent.com/${GH.owner}/${GH.repo}/${GH.branch}/`;
const MAX_BYTES = 5 * 1024 * 1024; // 5MB limit

// Helper: Sanitize filename
function slugify(name) {
  return (name || 'dish').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'dish';
}

// Helper: Parse multipart form data using Busboy
function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers, limits: { fileSize: MAX_BYTES } });
    let fileBuffer = null, fileName = '', dishName = '', tooBig = false;

    bb.on('file', (field, stream, info) => {
      fileName = info.filename || 'upload.jpg';
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('limit', () => { tooBig = true; });
      stream.on('end', () => { fileBuffer = Buffer.concat(chunks); });
    });
    bb.on('field', (name, val) => { if (name === 'dishName') dishName = val; });
    bb.on('error', reject);
    bb.on('finish', () => {
      if (tooBig) return reject(new Error('File exceeds 5 MB limit'));
      if (!fileBuffer) return reject(new Error('No file received'));
      resolve({ fileBuffer, fileName, dishName });
    });
    req.pipe(bb);
  });
}

// Main Handler
module.exports = async function handler(req, res) {
  // 1. Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // 2. Parse the uploaded file
    const { fileBuffer, fileName, dishName } = await parseMultipart(req);
    
    // 3. Prepare GitHub API payload
    const ext = (fileName.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
    const base = slugify(dishName || fileName.replace(/\.[^.]+$/, ''));
    const uniquePath = `${GH.folder}/${base}-${Date.now().toString(36)}.${ext}`;

    const body = {
      message: `Upload ${uniquePath}`,
      content: fileBuffer.toString('base64'), // GitHub requires Base64
      branch: GH.branch
    };

    // 4. Push to GitHub
    const ghRes = await fetch(
      `https://api.github.com/repos/${GH.owner}/${GH.repo}/contents/${uniquePath}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${GH.token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'User-Agent': 'tpot-uploader'
        },
        body: JSON.stringify(body)
      }
    );

    if (!ghRes.ok) {
      const err = await ghRes.json().catch(() => ({}));
      throw new Error(err.message || `GitHub API error: ${ghRes.status}`);
    }

    // 5. Return the raw URL to the browser
    const publicUrl = RAW_BASE + uniquePath;
    return res.status(200).json({ ok: true, url: publicUrl });

  } catch (err) {
    console.error('Upload error:', err);
    return res.status(400).json({ ok: false, error: err.message || 'Upload failed' });
  }
};
