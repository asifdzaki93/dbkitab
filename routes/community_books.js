const express = require('express');
const router = express.Router();
const multer = require('multer');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

// Setup Multer with Memory Storage (Vercel has no persistent local disk)
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 4.5 * 1024 * 1024 } // Vercel 4.5MB limit warning
});

// Setup S3 Client for Cloudflare R2
const s3Client = new S3Client({
  region: process.env.S3_REGION || 'auto',
  endpoint: process.env.S3_ENDPOINT,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY,
    secretAccessKey: process.env.S3_SECRET_KEY,
  }
});

/**
 * @swagger
 * /api/community-books/upload:
 *   post:
 *     summary: Upload a new community book
 *     tags: [Community Books]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *                 description: The book file to upload
 *               title:
 *                 type: string
 *                 description: Book title
 *               author:
 *                 type: string
 *                 description: Book author
 *               description:
 *                 type: string
 *                 description: Book description
 *               user_id:
 *                 type: string
 *                 description: ID of the user uploading the book
 *             required:
 *               - file
 *               - title
 *               - user_id
 *     responses:
 *       201:
 *         description: Book uploaded successfully
 *       400:
 *         description: Missing required fields
 */
router.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded.' });
  }

  const { title, author, description, user_id } = req.body;
  if (!title || !user_id) {
    return res.status(400).json({ error: 'Title and user_id are required.' });
  }

  const client = await pool.connect();
  try {
    // 1. Upload file to Cloudflare R2
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const fileName = `community_books/${uniqueSuffix}-${req.file.originalname}`;
    
    await s3Client.send(new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: fileName,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    }));

    // 2. Construct public URL using R2 Public URL
    const publicUrl = `${process.env.S3_PUBLIC_URL}/${fileName}`;

    // 3. Save to database
    const insertQuery = `
      INSERT INTO community_books (user_id, title, author, description, file_path, status)
      VALUES ($1, $2, $3, $4, $5, 'pending')
      RETURNING *;
    `;
    const values = [user_id, title, author, description, publicUrl];

    const result = await client.query(insertQuery, values);
    res.status(201).json({
      message: 'Book uploaded successfully to R2. Waiting for admin approval.',
      book: result.rows[0]
    });
  } catch (err) {
    console.error('Error uploading community book:', err);
    res.status(500).json({ error: 'Internal server error during upload.' });
  } finally {
    client.release();
  }
});

module.exports = router;
