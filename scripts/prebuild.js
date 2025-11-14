#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Check if any Convex authentication is set
const hasConvexAuth = 
  process.env.CONVEX_DEPLOY_KEY || 
  process.env.CONVEX_DEV_DEPLOY_KEY ||
  process.env.CONVEX_ACCESS_TOKEN;

if (!hasConvexAuth) {
  console.warn('⚠️  Warning: No Convex authentication found. Convex codegen may fail.');
  console.warn('   To fix: Set CONVEX_DEV_DEPLOY_KEY in Vercel environment variables.');
  console.warn('   Get it from: Convex Dashboard > Settings > Deploy Keys > Generate Dev Deploy Key');
} else {
  console.log('✓ Convex authentication found');
}

// Check if generated files exist
const generatedApiPath = path.join(__dirname, '../convex/_generated/api.d.ts');
if (fs.existsSync(generatedApiPath)) {
  console.log('✓ Convex generated files found');
} else {
  console.log('⚠️  Convex generated files not found - will attempt to generate during build');
}

process.exit(0);

