'use strict';

// Ref 43 (Field Visit Inspections): multer instance for technician-uploaded
// inspection photos. Separate from middleware/upload.js because the destination
// (config.fieldVisitPhotosDir), the size ceiling (a single phone photo, not bulk
// signage content) and the type filter (images only) all differ.

const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const config = require('../config');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, config.fieldVisitPhotosDir);
  },
  filename: (req, file, cb) => {
    // Same UTF-8 recovery as middleware/upload.js (busboy decodes the filename
    // header as latin1). The stored name is a random uuid + extension, so this
    // only matters for deriving a sane extension.
    if (file.originalname) {
      file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
    }
    const ext = path.extname(file.originalname).toLowerCase().slice(0, 10);
    cb(null, `${uuidv4()}${ext}`);
  },
});

const fileFilter = (req, file, cb) => {
  if (file.mimetype && file.mimetype.startsWith('image/')) {
    cb(null, true);
  } else {
    cb(new Error('Only image files are allowed for field-visit photos'), false);
  }
};

const fieldVisitUpload = multer({
  storage,
  fileFilter,
  limits: { fileSize: config.fieldVisitPhotoMaxBytes },
  defParamCharset: 'utf8',
});

module.exports = fieldVisitUpload;
