// reorganize-project.js
// Script to reorganize project structure

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const moves = [
  // Server files
  { from: 'server.js', to: 'src/server/index.js' },
  { from: 'db.js', to: 'src/server/config/db.js' },
  { from: 'loadSecrets.js', to: 'src/server/config/secrets.js' },
  { from: 'auth.js', to: 'src/server/middleware/auth.js' },
  { from: 'ipFilter.js', to: 'src/server/middleware/ipFilter.js' },
  { from: 'dbQueries.js', to: 'src/server/models/dbQueries.js' },
  { from: 'generateSessionName.js', to: 'src/server/services/sessionName.service.js' },
  { from: 'redact.js', to: 'src/server/services/redaction.service.js' },

  // Client main files
  { from: 'client/entry-client.jsx', to: 'src/client/main/entry-client.jsx' },
  { from: 'client/entry-server.jsx', to: 'src/client/main/entry-server.jsx' },
  { from: 'client/pages/index.jsx', to: 'src/client/main/pages/index.jsx' },
  { from: 'client/components/App.jsx', to: 'src/client/main/components/App.jsx' },
  { from: 'client/components/header.jsx', to: 'src/client/main/components/Header.jsx' },
  { from: 'client/components/ChatLog.jsx', to: 'src/client/main/components/ChatLog.jsx' },
  { from: 'client/components/SessionControls.jsx', to: 'src/client/main/components/SessionControls.jsx' },
  { from: 'client/components/SessionSettings.jsx', to: 'src/client/main/components/SessionSettings.jsx' },
  { from: 'client/components/Login.jsx', to: 'src/client/main/components/Login.jsx' },
  { from: 'client/components/Profile.jsx', to: 'src/client/main/components/Profile.jsx' },
  { from: 'client/components/UserSessionDetail.jsx', to: 'src/client/main/components/UserSessionDetail.jsx' },
  { from: 'client/components/EventLog.jsx', to: 'src/client/main/components/EventLog.jsx' },
  { from: 'client/components/Settings.jsx', to: 'src/client/main/components/Settings.jsx' },

  // Client shared components
  { from: 'client/components/Button.jsx', to: 'src/client/shared/components/Button.jsx' },
  { from: 'client/components/copyButton.jsx', to: 'src/client/shared/components/CopyButton.jsx' },
  { from: 'client/components/ProtectedRoute.jsx', to: 'src/client/shared/components/ProtectedRoute.jsx' },

  // Client admin files
  { from: 'client/admin/admin-entry-client.jsx', to: 'src/client/admin/admin-entry-client.jsx' },
  { from: 'client/admin/admin-entry-server.jsx', to: 'src/client/admin/admin-entry-server.jsx' },
  { from: 'client/admin/components/AdminApp.jsx', to: 'src/client/admin/components/AdminApp.jsx' },
  { from: 'client/admin/components/AdminHeader.jsx', to: 'src/client/admin/components/AdminHeader.jsx' },
  { from: 'client/admin/components/Analytics.jsx', to: 'src/client/admin/components/Analytics.jsx' },
  { from: 'client/admin/components/SessionList.jsx', to: 'src/client/admin/components/SessionList.jsx' },
  { from: 'client/admin/components/SessionDetail.jsx', to: 'src/client/admin/components/SessionDetail.jsx' },
  { from: 'client/admin/components/UserManagement.jsx', to: 'src/client/admin/components/UserManagement.jsx' },
  { from: 'client/admin/components/ExportPanel.jsx', to: 'src/client/admin/components/ExportPanel.jsx' },
  { from: 'client/admin/components/FilterBar.jsx', to: 'src/client/admin/components/FilterBar.jsx' },
  { from: 'client/admin/components/ConversationBubble.jsx', to: 'src/client/admin/components/ConversationBubble.jsx' },

  // Database files
  { from: 'migrations/001_create_users_table.sql', to: 'src/database/migrations/001_create_users_table.sql' },
  { from: 'migrations/002_insert_initial_user.js', to: 'src/database/migrations/002_insert_initial_user.js' },
  { from: 'migrations/003_normalize_schema.sql', to: 'src/database/migrations/003_normalize_schema.sql' },
  { from: 'migrations/003_normalize_schema_rollback.sql', to: 'src/database/migrations/003_normalize_schema_rollback.sql' },
  { from: 'migrations/004_change_session_id_to_text.sql', to: 'src/database/migrations/004_change_session_id_to_text.sql' },
  { from: 'migrations/004_change_session_id_to_text_rollback.sql', to: 'src/database/migrations/004_change_session_id_to_text_rollback.sql' },
  { from: 'migrations/005_add_language_to_session_config.sql', to: 'src/database/migrations/005_add_language_to_session_config.sql' },
  { from: 'migrations/005_add_language_to_session_config_rollback.sql', to: 'src/database/migrations/005_add_language_to_session_config_rollback.sql' },
  { from: 'migrations/runMigration.js', to: 'src/database/scripts/runMigration.js' },
  { from: 'migrations/runMigration004.js', to: 'src/database/scripts/runMigration004.js' },
  { from: 'migrations/runMigration005.js', to: 'src/database/scripts/runMigration005.js' },
  { from: 'migrations/rollbackMigration.js', to: 'src/database/scripts/rollbackMigration.js' },
  { from: 'migrations/MIGRATION_GUIDE.md', to: 'src/database/scripts/MIGRATION_GUIDE.md' },

  // Documentation
  { from: 'db.md', to: 'docs/db.md' },
];

function ensureDirectoryExists(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`  📁 Created directory: ${dir}`);
  }
}

function moveFile(from, to) {
  const fromPath = path.join(__dirname, from);
  const toPath = path.join(__dirname, to);

  if (!fs.existsSync(fromPath)) {
    console.log(`  ⚠️  Skipping (not found): ${from}`);
    return false;
  }

  ensureDirectoryExists(toPath);
  fs.renameSync(fromPath, toPath);
  console.log(`  ✅ Moved: ${from} → ${to}`);
  return true;
}

function cleanupEmptyDirs() {
  const dirsToCheck = ['client/components', 'client/pages', 'client/admin/components', 'migrations'];

  dirsToCheck.forEach(dir => {
    const dirPath = path.join(__dirname, dir);
    if (fs.existsSync(dirPath)) {
      const files = fs.readdirSync(dirPath);
      if (files.length === 0) {
        fs.rmdirSync(dirPath);
        console.log(`  🗑️  Removed empty directory: ${dir}`);
      }
    }
  });
}

async function main() {
  console.log('\n🚀 Starting project reorganization...\n');

  let movedCount = 0;
  let skippedCount = 0;

  for (const move of moves) {
    const success = moveFile(move.from, move.to);
    if (success) {
      movedCount++;
    } else {
      skippedCount++;
    }
  }

  console.log('\n🧹 Cleaning up empty directories...\n');
  cleanupEmptyDirs();

  console.log('\n✨ Reorganization complete!');
  console.log(`   📦 Moved: ${movedCount} files`);
  console.log(`   ⚠️  Skipped: ${skippedCount} files\n`);

  console.log('⚠️  NEXT STEPS:');
  console.log('   1. Update import paths in your code');
  console.log('   2. Update vite.config.js and vite.admin.config.js');
  console.log('   3. Update package.json scripts if needed');
  console.log('   4. Test the application\n');
}

main().catch(console.error);
