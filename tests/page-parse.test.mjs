import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { startServer } from '../engine/server.mjs';
import {
  MEDIA_EXTENSIONS as ENGINE_MEDIA,
  SUBTITLE_EXTENSIONS as ENGINE_SUBS,
  collectPage,
  parseHtmlPage,
  parseSubtitleDocument,
} from '../engine/page/parse.mjs';
import {
  MEDIA_EXTENSIONS as STUDIO_MEDIA,
  SUBTITLE_EXTENSIONS as STUDIO_SUBS,
  chooseSubtitleTrack,
  cuesForSession,
  isDirectMediaUrl,
  isDirectSubtitleUrl,
  isLoadableVideo,
} from '../studio/page-kit.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function publicLookup() {
  return [{ address: '93.184.216.34', family: 4 }];
}

function htmlResponse(body, status = 200, headers = {}) {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });
}

function textResponse(body, contentType) {
  return new Response(body, { status: 200, headers: { 'content-type': contentType } });
}

test('页面地址判断：直接媒体、字幕和不能播放的站点流分开', () => {
  assert.deepEqual([...STUDIO_MEDIA], [...ENGINE_MEDIA]);
  assert.deepEqual([...STUDIO_SUBS], [...ENGINE_SUBS]);
  assert.equal(isDirectMediaUrl('https://cdn.example.com/a.MP4?x=1'), true);
  assert.equal(isDirectMediaUrl('https://youtu.be/abc'), false);
  assert.equal(isDirectSubtitleUrl('https://cdn.example.com/captions.vtt#t'), true);
  assert.equal(isLoadableVideo({ url: 'https://rr.googlevideo.com/videoplayback?id=1', mime: 'video/mp4' }), false);
  assert.equal(isLoadableVideo({ url: 'https://www.youtube.com/watch?v=abc', mime: 'video/mp4' }), false);
  assert.equal(isLoadableVideo({ url: 'https://cdn.example.com/talk', mime: 'audio/mpeg' }), true);
  assert.equal(isLoadableVideo({ url: 'https://cdn.example.com/lecture.mp4' }), true);
  const chosen = chooseSubtitleTrack([
    { lang: 'zh-Hans', cues: [{ t0Ms: 0, t1Ms: 1, text: '中文' }] },
    { lang: 'en', syntheticTiming: true, cues: [{ t0Ms: 0, t1Ms: 1, text: '假时间' }] },
    { lang: 'en-US', cues: [{ t0Ms: 0, t1Ms: 1000, text: 'English' }] },
  ]);
  assert.equal(chosen.lang, 'en-US');
  assert.equal(cuesForSession({ subtitles: [{ lang: 'en', syntheticTiming: true, cues: [{ t0Ms: 0, t1Ms: 1, text: 'no' }] }] }).length, 0);
});

test('字幕文档：VTT、SRT、timedtext XML、json3、B 站 JSON', () => {
  const vtt = parseSubtitleDocument(`WEBVTT

00:00:01.000 --> 00:00:03.500
Learning &amp; rate <c>starts</c> here`);
  assert.deepEqual(vtt, [{ t0Ms: 1000, t1Ms: 3500, text: 'Learning & rate starts here' }]);

  const srt = parseSubtitleDocument('1\n00:00:01,000 --> 00:00:04,000\nHello class\n');
  assert.deepEqual(srt, [{ t0Ms: 1000, t1Ms: 4000, text: 'Hello class' }]);

  const xml = parseSubtitleDocument('<transcript><text start="1.25" dur="2.5">Hello &amp; class</text></transcript>');
  assert.deepEqual(xml, [{ t0Ms: 1250, t1Ms: 3750, text: 'Hello & class' }]);

  const json3 = parseSubtitleDocument(JSON.stringify({
    events: [{ tStartMs: 1500, dDurationMs: 2000, segs: [{ utf8: 'rate ' }, { utf8: 'starts' }] }],
  }));
  assert.deepEqual(json3, [{ t0Ms: 1500, t1Ms: 3500, text: 'rate starts' }]);

  const bili = parseSubtitleDocument(JSON.stringify({ body: [{ from: 2, to: 5.5, content: '你好 &amp; hello' }] }));
  assert.deepEqual(bili, [{ t0Ms: 2000, t1Ms: 5500, text: '你好 & hello' }]);

  const many = parseSubtitleDocument(Array.from({ length: 201 }, (_, i) => `00:00:${String(i % 60).padStart(2, '0')}.000 --> 00:00:${String(i % 60).padStart(2, '0')}.500\nline ${i}\n`).join('\n'));
  assert.equal(many.length, 200);
  assert.equal(many[0].text, 'line 0');
});

test('普通 HTML：标题、直接视频、字幕；跳过 data/javascript，不把无时间轴文稿编成字幕', async () => {
  const pageUrl = 'https://course.example.edu/week/1/';
  const html = `<!doctype html><html><head>
    <meta property="og:title" content="Week 1">
    <title>ignored</title>
  </head><body>
    <video>
      <source src="media/lecture.mp4" type="video/mp4">
      <source src="javascript:alert(1)">
      <source src=extra.mp3 type=audio/mpeg>
    </video>
    <track kind="subtitles" srclang="en" label="English" src="subs/en.vtt">
    <a href="notes.srt">notes</a>
    <a href="data:text/vtt,WEBVTT">bad</a>
    <script type="application/ld+json">
      {"@type":"VideoObject","name":"LD","contentUrl":"https://cdn.example.com/from-ld.webm","transcript":"just words without time"}
    </script>
  </body></html>`;
  const calls = [];
  const result = await collectPage(pageUrl, {
    lookup: publicLookup,
    fetch: async (url) => {
      calls.push(String(url));
      if (url === pageUrl) return htmlResponse(html);
      if (url === 'https://course.example.edu/week/1/subs/en.vtt') {
        return textResponse('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nslide one\n', 'text/vtt');
      }
      if (url === 'https://course.example.edu/week/1/notes.srt') {
        return textResponse('1\n00:00:03,000 --> 00:00:04,000\nnotes line\n', 'application/x-subrip');
      }
      throw new Error(`unexpected ${url}`);
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.kind, 'page');
  assert.equal(result.site, 'generic');
  assert.equal(result.title, 'Week 1');
  assert.deepEqual(result.videos.map((item) => item.url).sort(), [
    'https://cdn.example.com/from-ld.webm',
    'https://course.example.edu/week/1/extra.mp3',
    'https://course.example.edu/week/1/media/lecture.mp4',
  ]);
  assert.equal(calls.some((url) => url.startsWith('javascript:') || url.startsWith('data:')), false);
  const en = result.subtitles.find((track) => track.lang === 'en');
  assert.equal(en.cues[0].text, 'slide one');
  assert.equal(result.cueCount, 2);
  assert.equal(result.warning, undefined);
  assert.equal(cuesForSession(result)[0].text, 'slide one');
});

test('脚本里的比较符号不会把页面解析挂住', () => {
  const html = `<html><head><title>Kept</title></head><body>
    <script>if (a<0 && ua.indexOf("Edge")< 0 && path.indexOf("a/b")<1) {}</script>
    <video src="lecture.mp4"></video>
  </body></html>`;
  const started = Date.now();
  const page = parseHtmlPage(html, 'https://course.example/week/');
  assert.ok(Date.now() - started < 1000);
  assert.equal(page.title, 'Kept');
  assert.equal(page.videos[0].url, 'https://course.example/week/lecture.mp4');
});

test('只有无时间轴文稿时不生成 cue', async () => {
  const result = await collectPage('https://course.example.edu/plain', {
    lookup: publicLookup,
    fetch: async () => htmlResponse('<html><head><title>Plain</title></head><body><script type="application/ld+json">{"@type":"VideoObject","transcript":"a paragraph"}</script></body></html>'),
  });
  assert.equal(result.cueCount, 0);
  assert.match(result.warning, /没有时间轴/);
  assert.equal(cuesForSession(result).length, 0);
});

test('YouTube 观看页只取标题和字幕，不抓 googlevideo', async () => {
  const watch = 'https://www.youtube.com/watch?v=abc';
  const html = `<html><head><title>html title</title></head><body><script>var ytInitialPlayerResponse = ${JSON.stringify({
    videoDetails: { title: 'Lecture: Learning Rate' },
    streamingData: { formats: [{ url: 'https://rr3---sn.googlevideo.com/videoplayback?id=1' }] },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: [
      { baseUrl: 'https://www.youtube.com/api/timedtext?v=abc&lang=en', languageCode: 'en', name: { simpleText: 'English' } },
      { baseUrl: 'https://www.youtube.com/api/timedtext?v=abc&lang=zh-Hans', languageCode: 'zh-Hans', name: { simpleText: 'Chinese' } },
    ] } },
  })};</script></body></html>`;
  const calls = [];
  const result = await collectPage(watch, {
    lookup: publicLookup,
    fetch: async (url) => {
      const href = String(url);
      calls.push(href);
      if (href.includes('googlevideo')) throw new Error('fetched stream');
      if (href === watch) return htmlResponse(html);
      const parsed = new URL(href);
      assert.equal(parsed.searchParams.get('fmt'), 'vtt');
      if (parsed.searchParams.get('lang') === 'en') {
        return textResponse('WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nLearning rate\n', 'text/vtt');
      }
      return textResponse('<transcript><text start="4" dur="1">中文</text></transcript>', 'text/xml');
    },
  });
  assert.equal(result.site, 'youtube');
  assert.equal(result.title, 'Lecture: Learning Rate');
  assert.deepEqual(result.videos, []);
  assert.equal(calls.some((url) => url.includes('googlevideo')), false);
  const en = result.subtitles.find((track) => track.lang === 'en');
  assert.equal(en.cues[0].text, 'Learning rate');
  const zh = result.subtitles.find((track) => track.lang === 'zh-Hans');
  assert.equal(zh.cues[0].text, '中文');
  assert.match(result.warning, /视频文件不在页面里/);
  assert.equal(cuesForSession(result)[0].text, 'Learning rate');
});

test('YouTube 同意墙没有字幕时给出说明，不抛错', async () => {
  const result = await collectPage('https://www.youtube.com/watch?v=consent', {
    lookup: publicLookup,
    fetch: async () => htmlResponse('<html><head><title>Before you continue</title></head><body>consent</body></html>'),
  });
  assert.equal(result.ok, true);
  assert.equal(result.cueCount, 0);
  assert.deepEqual(result.videos, []);
  assert.match(result.warning, /没有读到带时间轴的字幕/);
});

test('B 站取字幕 JSON，不抓 bilivideo', async () => {
  const watch = 'https://www.bilibili.com/video/BV1xx/';
  const html = `<html><head><title>网页标题</title></head><body><script>window.__INITIAL_STATE__=${JSON.stringify({
    videoData: { title: '梯度下降', dash: { video: [{ baseUrl: 'https://upos-sz-mirror.bilivideo.com/upgcxcode/a.m4s' }] } },
    subtitle: { subtitles: [
      { lan: 'en', lan_doc: 'English', subtitle_url: '//aisub.example.com/en.json' },
      { lan: 'ai-zh', lan_doc: '中文', subtitle_url: 'https://aisub.example.com/zh.json' },
    ] },
  })};</script></body></html>`;
  const calls = [];
  const result = await collectPage(watch, {
    lookup: publicLookup,
    fetch: async (url, init) => {
      const href = String(url);
      calls.push(href);
      if (href.includes('bilivideo')) throw new Error('fetched dash');
      if (href === watch) return htmlResponse(html);
      if (href === 'https://aisub.example.com/en.json') {
        assert.equal(new URL(init?.headers?.referer).href, watch);
        return textResponse(JSON.stringify({ body: [{ from: 2, to: 5.5, content: 'gradient descent' }] }), 'application/json');
      }
      return textResponse(JSON.stringify({ body: [{ from: 2, to: 4, content: '梯度' }] }), 'application/json');
    },
  });
  assert.equal(result.site, 'bilibili');
  assert.equal(result.title, '梯度下降');
  assert.deepEqual(result.videos, []);
  assert.equal(calls.some((url) => url.includes('bilivideo')), false);
  assert.equal(result.subtitles.find((track) => track.lang === 'en').cues[0].text, 'gradient descent');
  assert.equal(result.subtitles.find((track) => track.lang === 'en').cues[0].t0Ms, 2000);
  assert.equal(cuesForSession(result)[0].text, 'gradient descent');
});

test('直接媒体看 Content-Type，不把正文读进结果；重定向停在 https', async () => {
  const calls = [];
  const media = await collectPage('https://cdn.example.com/lecture.mp4', {
    lookup: publicLookup,
    fetch: async (url) => {
      calls.push(String(url));
      return new Response('SECRET-BODY', { status: 200, headers: { 'content-type': 'video/mp4' } });
    },
  });
  assert.equal(media.kind, 'media');
  assert.equal(media.videos[0].url, 'https://cdn.example.com/lecture.mp4');
  assert.equal(media.videos[0].mime, 'video/mp4');
  assert.equal(JSON.stringify(media).includes('SECRET-BODY'), false);

  const redirected = await collectPage('http://course.example/start', {
    lookup: publicLookup,
    fetch: async (url) => {
      if (url === 'http://course.example/start') return new Response(null, { status: 302, headers: { location: 'https://course.example/final/' } });
      return htmlResponse('<html><head><meta property="og:title" content="Final"></head><body><video src="talk.mp4"></video></body></html>');
    },
  });
  assert.equal(redirected.finalUrl, 'https://course.example/final/');
  assert.equal(redirected.title, 'Final');
  assert.equal(redirected.videos[0].url, 'https://course.example/final/talk.mp4');
});

test('拒绝 file、用户信息、云元数据和链路本地地址；本机与局域网可以抓', async () => {
  let fetches = 0;
  const fetchImpl = async () => {
    fetches += 1;
    return htmlResponse('<html><head><title>ok</title></head></html>');
  };
  const blocked = [
    'file:///tmp/a.mp4',
    'javascript:alert(1)',
    'http://user:pass@course.example/a',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://169.254.169.254/latest',
    'http://[fe80::1]/',
  ];
  for (const url of blocked) {
    fetches = 0;
    await assert.rejects(() => collectPage(url, { fetch: fetchImpl, lookup: publicLookup }), (err) => {
      assert.equal(fetches, 0, url);
      assert.ok(err.statusCode === 400, url);
      return true;
    });
  }

  fetches = 0;
  await assert.rejects(
    () => collectPage('http://course.example/go', {
      lookup: publicLookup,
      fetch: async (url) => {
        fetches += 1;
        if (url === 'http://course.example/go') return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest' } });
        throw new Error('followed metadata');
      },
    }),
    (err) => err.code === 'blocked_url',
  );
  assert.equal(fetches, 1);

  let lookups = 0;
  const local = await collectPage('http://127.0.0.1:9/course', {
    lookup: async () => {
      lookups += 1;
      return [{ address: '127.0.0.1', family: 4 }];
    },
    fetch: async () => htmlResponse('<html><head><title>local</title></head></html>'),
  });
  assert.equal(local.title, 'local');
  assert.equal(lookups, 0);

  const lan = await collectPage('http://192.168.1.10/course', {
    lookup: async () => {
      throw new Error('should not resolve an IP');
    },
    fetch: async () => htmlResponse('<html><head><title>lan</title></head></html>'),
  });
  assert.equal(lan.title, 'lan');

  const loopback6 = await collectPage('http://[::1]/course', {
    lookup: async () => {
      throw new Error('should not resolve an IP');
    },
    fetch: async () => htmlResponse('<html><head><title>v6</title></head></html>'),
  });
  assert.equal(loopback6.title, 'v6');

  await assert.rejects(
    () => collectPage('http://evil.example/page', {
      fetch: fetchImpl,
      lookup: async () => [{ address: '169.254.169.254', family: 4 }],
    }),
    (err) => err.code === 'blocked_url',
  );
});

test('POST /api/page/parse 用注入的抓取，并拒绝错误方法', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'livedub-page-'));
  const srv = await startServer({
    port: 0,
    host: '127.0.0.1',
    log: () => {},
    dataDir,
    closeAsrOnShutdown: false,
    desktopAppPath: path.join(dataDir, 'no-app'),
    config: {
      server: { host: '127.0.0.1', port: 0 },
      translate: { provider: 'deepseek', chain: ['deepseek'] },
      asr: { provider: 'mock' },
      tts: { provider: 'mock' },
    },
    sessionFactory: async () => ({ onAudio() {}, onJson() {}, async close() {} }),
    visionFactory: async () => {
      throw new Error('vision disabled');
    },
    pageLookup: publicLookup,
    pageFetch: async (url) => {
      if (url === 'https://www.youtube.com/watch?v=abc') {
        return htmlResponse(`<script>ytInitialPlayerResponse = ${JSON.stringify({
          videoDetails: { title: 'From API' },
          captions: { playerCaptionsTracklistRenderer: { captionTracks: [
            { baseUrl: 'https://www.youtube.com/api/timedtext?v=abc&lang=en', languageCode: 'en', name: { simpleText: 'English' } },
          ] } },
        })};</script>`);
      }
      return textResponse('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nfrom api\n', 'text/vtt');
    },
  });
  try {
    const get = await fetch(`${srv.url}/api/page/parse`);
    assert.equal(get.status, 405);
    const unknown = await fetch(`${srv.url}/api/page/parse`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=abc', secret: 'x' }),
    });
    assert.equal(unknown.status, 400);
    const blocked = await fetch(`${srv.url}/api/page/parse`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'file:///tmp/a.html' }),
    });
    assert.equal(blocked.status, 400);
    const ok = await fetch(`${srv.url}/api/page/parse`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=abc' }),
    });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.ok, true);
    assert.equal(body.title, 'From API');
    assert.equal(body.videos.length, 0);
    assert.equal(body.subtitles[0].cues[0].text, 'from api');
  } finally {
    await srv.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('工作台把课程页交给 /api/page/parse，直接媒体仍走播放器', () => {
  const app = fs.readFileSync(path.join(root, 'studio/app.mjs'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'studio/index.html'), 'utf8');
  assert.match(app, /\/api\/page\/parse/);
  assert.match(app, /state\.pageCues/);
  assert.match(app, /isDirectMediaUrl/);
  assert.match(app, /cuesForSession/);
  assert.match(html, /YouTube、B站/);
  assert.match(html, /课程页 \/ 视频 URL/);
});
