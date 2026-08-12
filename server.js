const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8856;
const DATA_FILE = path.join(__dirname, 'data', 'data.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/assets', express.static(path.join(__dirname, 'assets')));
app.use(session({
  secret: 'ottohub_download_secret_' + Date.now(),
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000, httpOnly: true }
}));

// OTTOMEDIA 分组默认结构：apple 组（iOS/macOS 共用版本号）、cross 组（Android/Windows 共用版本号）
const OTTOMEDIA_DEFAULTS = {
  apple: { version: '', iosUrl: '', macUrl: '', size: '', forceMinVersion: '', changelog: [] },
  cross: { version: '', androidUrl: '', windowsUrl: '', size: '', forceMinVersion: '', changelog: [] }
};

// 产品级法律文档链接默认结构：hub 组（OTTOhub）、media 组（OTTOMEDIA）
const LEGAL_DEFAULTS = {
  hub: { userAgreement: '', privacyPolicy: '' },
  media: { userAgreement: '', privacyPolicy: '' }
};

// 更新检测 API 平台 → 版本分组。四大版本分组：
//   hub_android（OTTOhub 安卓）、hub_ios（OTTOhub iOS）
//   media_apple（OTTOMEDIA iOS/macOS 共用版本）、media_win（OTTOMEDIA Windows/安卓 共用版本）
// 媒体组返回本组全部下载链接（urls），由设备自取，确保不串组
const HUB_PLATFORMS = {
  hub_android: { dataKey: 'android' },
  hub_ios: { dataKey: 'ios' }
};

const MEDIA_GROUP_PLATFORMS = {
  media_apple: { group: 'apple' },
  media_win: { group: 'cross' }
};

// 旧版兼容：ottomedia_* 历史标识 → 单平台下载链接字段
const OTTOMEDIA_PLATFORMS = {
  ottomedia_ios: { group: 'apple', urlField: 'iosUrl' },
  ottomedia_macos: { group: 'apple', urlField: 'macUrl' },
  ottomedia_android: { group: 'cross', urlField: 'androidUrl' },
  ottomedia_windows: { group: 'cross', urlField: 'windowsUrl' }
};

function readData() {
  const raw = fs.readFileSync(DATA_FILE, 'utf-8');
  return JSON.parse(raw);
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 4), 'utf-8');
}

// 补齐缺失的默认结构（旧数据文件没有 ottomedia/legal 字段时）
function normalizeData(data) {
  data.android = data.android || {};
  data.ios = data.ios || {};
  data.ottomedia = data.ottomedia || {};
  data.ottomedia.apple = { ...OTTOMEDIA_DEFAULTS.apple, ...data.ottomedia.apple };
  data.ottomedia.cross = { ...OTTOMEDIA_DEFAULTS.cross, ...data.ottomedia.cross };
  data.legal = data.legal || {};
  data.legal.hub = { ...LEGAL_DEFAULTS.hub, ...data.legal.hub };
  data.legal.media = { ...LEGAL_DEFAULTS.media, ...data.legal.media };
  return data;
}

function requireAuth(req, res, next) {
  if (req.session.isAdmin) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

function compareVersion(a, b) {
  const pa = a.replace(/^v/i, '').split('.').map(Number);
  const pb = b.replace(/^v/i, '').split('.').map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na < nb) return -1;
    if (na > nb) return 1;
  }
  return 0;
}

// 将管理端提交的平台配置合并进数据（changelog 单独处理，避免误删）
function applyPlatformPatch(target, patch) {
  if (!target || !patch) return;
  if (patch.changelog !== undefined) {
    target.changelog = patch.changelog;
    delete patch.changelog;
  }
  Object.assign(target, patch);
}

app.get('/api/data', (req, res) => {
  const data = normalizeData(readData());
  const { platform, version } = req.query;

  if (platform) {
    // 媒体四大分组之一：只返回本组数据（不带 version 时返回本组配置）
    const mediaGroup = MEDIA_GROUP_PLATFORMS[platform];
    if (mediaGroup) {
      const group = data.ottomedia[mediaGroup.group] || {};
      if (version) {
        // 更新检测：本组版本 + 本组全部下载链接（法律文档走 /api/legal 独立接口）
        const urls = mediaGroup.group === 'apple'
          ? { ios: group.iosUrl || null, macos: group.macUrl || null }
          : { android: group.androidUrl || null, windows: group.windowsUrl || null };
        const forceUpdate = compareVersion(version, group.forceMinVersion || '0.0.0') <= 0;
        const hasUpdate = compareVersion(version, group.version || '0.0.0') < 0;
        return res.json({
          platform,
          latestVersion: group.version,
          forceUpdate,
          hasUpdate,
          urls,
          changelog: group.changelog || []
        });
      }
      // 只查询本组配置，不带其他组数据
      return res.json({ platform, ...group });
    }

    let cfg = data[platform]; // 兼容旧标识：android / ios
    let urlField = 'url';
    if (HUB_PLATFORMS[platform]) {
      cfg = data[HUB_PLATFORMS[platform].dataKey];
    }
    if (OTTOMEDIA_PLATFORMS[platform]) {
      const o = OTTOMEDIA_PLATFORMS[platform];
      cfg = data.ottomedia[o.group];
      urlField = o.urlField;
    }
    if (!cfg) return res.status(400).json({ error: 'Invalid platform' });

    if (version) {
      const forceUpdate = compareVersion(version, cfg.forceMinVersion || '0.0.0') <= 0;
      const hasUpdate = compareVersion(version, cfg.version || '0.0.0') < 0;
      return res.json({
        platform,
        latestVersion: cfg.version,
        forceUpdate,
        hasUpdate,
        downloadUrl: cfg[urlField] || null,
        changelog: cfg.changelog || []
      });
    }
    // 只查询本组配置，不带其他组数据
    return res.json({ platform, ...cfg });
  }

  const { admin_password, ...publicData } = data;
  res.json(publicData);
});

app.get('/api/legal', (req, res) => {
  const data = normalizeData(readData());
  const { product } = req.query;
  if (!product || !data.legal[product]) {
    return res.status(400).json({ error: 'Invalid product, use "hub" or "media"' });
  }
  res.json({
    product,
    userAgreement: data.legal[product].userAgreement || '',
    privacyPolicy: data.legal[product].privacyPolicy || ''
  });
});

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password required' });
  const data = readData();
    const hash = data.admin_password.replace(/^\$2y\$/, '$2a$');
    const valid = bcrypt.compareSync(password, hash);
  if (!valid) return res.status(401).json({ error: 'Invalid password' });
  req.session.isAdmin = true;
  res.json({ success: true });
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

app.get('/api/admin/check', (req, res) => {
  res.json({ authenticated: !!req.session.isAdmin });
});

app.put('/api/admin/data', requireAuth, (req, res) => {
  const { android, ios, ottomedia, legal } = req.body;
  const data = normalizeData(readData());
  applyPlatformPatch(data.android, android);
  applyPlatformPatch(data.ios, ios);
  if (ottomedia) {
    applyPlatformPatch(data.ottomedia.apple, ottomedia.apple);
    applyPlatformPatch(data.ottomedia.cross, ottomedia.cross);
  }
  if (legal) {
    applyPlatformPatch(data.legal.hub, legal.hub);
    applyPlatformPatch(data.legal.media, legal.media);
  }
  writeData(data);
  const { admin_password, ...publicData } = data;
  res.json(publicData);
});

app.listen(PORT, () => {
  console.log(`OTTO HUB download server running at http://localhost:${PORT}`);
});
