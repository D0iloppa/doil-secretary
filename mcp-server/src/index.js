#!/usr/bin/env node
'use strict';

const { serve } = require('./server');

serve().catch((err) => {
  console.error('doil-secretary-mcp failed to start:', err);
  process.exit(1);
});
