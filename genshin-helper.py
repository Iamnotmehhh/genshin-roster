#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
原神角色养成记录 - 本地助手（零依赖，纯标准库）
====================================================
功能：
  1. 本地服务器：在浏览器里直接服务 index.html（启动后自动打开应用窗口）
  2. UID 展柜同步：输入 UID 走 Enka 展柜接口同步角色/武器/圣遗物（无需登录），
     多线路抓取 + 磁盘缓存，中文名来自 Enka 官方 store/gi/locs.json
  ※ 米游社登录/同步通道已撤下（扫码风控无法绕过），完整代码备份在
     backup/米游社登录功能备份/，需要时可整体恢复。

启动：双击 原神养成记录助手.exe（打包版），或命令行 python genshin-helper.py
"""
import hashlib
import json
import re
import os
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ---------------- 配置 ----------------
PORT = int(os.environ.get("HELPER_PORT", "8642"))
HERE = os.path.dirname(os.path.abspath(sys.argv[0] if getattr(sys, "frozen", False) else __file__))
BASE = getattr(sys, "_MEIPASS", HERE)               # PyInstaller 打包后资源目录
INDEX_HTML = os.path.join(BASE, "index.html")
# ---------------- UID 展柜同步（Enka 线路，无需登录） ----------------
# 数据源：enka.network/api/uid/{uid}（国内直连常被墙，走多线路赛跑 + 磁盘缓存兜底）
# 名字解析：Enka 官方 store/gi/locs.json（zh-cn，含全部角色/武器名的 Enka hash 映射）
#           + store/characters.json（SkillOrder 天赋顺序）
ENKA_UID_URL = "https://enka.network/api/uid/"
ENKA_LOC_URL = "https://gcore.jsdelivr.net/gh/EnkaNetwork/API-docs@master/store/gi/locs.json"
ENKA_AVATAR_URL = "https://gcore.jsdelivr.net/gh/EnkaNetwork/API-docs@master/store/gi/avatars.json"
ENKA_WEAPON_URL = "https://gcore.jsdelivr.net/gh/EnkaNetwork/API-docs@master/store/gi/weapons.json"
ENKA_LOCS_CACHE = os.path.join(HERE, "enka静态数据缓存.json")
ENKA_UID_CACHE = os.path.join(HERE, "展柜缓存.json")
UID_CACHE_TTL = 6 * 3600          # 展柜数据缓存 6 小时
STATIC_TTL = 7 * 24 * 3600        # 静态名字数据缓存 7 天

EQUIP_SLOT = {                    # Enka equipType → 应用内部位
    "EQUIP_BRACER": "花", "EQUIP_NECKLACE": "羽", "EQUIP_SHOES": "沙",
    "EQUIP_RING": "杯", "EQUIP_DRESS": "头",
}
SUBSTAT_MAP = {                   # Enka appendPropId → 应用内属性键（百分比带%号）
    "FIGHT_PROP_HP": "生命值", "FIGHT_PROP_HP_PERCENT": "生命值%",
    "FIGHT_PROP_ATTACK": "攻击力", "FIGHT_PROP_ATTACK_PERCENT": "攻击力%",
    "FIGHT_PROP_DEFENSE": "防御力", "FIGHT_PROP_DEFENSE_PERCENT": "防御力%",
    "FIGHT_PROP_CRITICAL": "暴击率", "FIGHT_PROP_CRITICAL_HURT": "暴击伤害",
    "FIGHT_PROP_CHARGE_EFFICIENCY": "元素充能", "FIGHT_PROP_ELEMENT_MASTERY": "元素精通",
}
MAIN_MAP = {                      # Enka 主词条 appendPropId → 圣遗物筛选模块的主词条名
    "FIGHT_PROP_HP": "固定生命值", "FIGHT_PROP_ATTACK": "固定攻击力",
    "FIGHT_PROP_HP_PERCENT": "生命值%", "FIGHT_PROP_ATTACK_PERCENT": "攻击力%",
    "FIGHT_PROP_DEFENSE_PERCENT": "防御力%",
    "FIGHT_PROP_CHARGE_EFFICIENCY": "元素充能效率", "FIGHT_PROP_ELEMENT_MASTERY": "元素精通",
    "FIGHT_PROP_CRITICAL": "暴击率", "FIGHT_PROP_CRITICAL_HURT": "暴击伤害",
    "FIGHT_PROP_HEAL_ADD": "治疗加成",
    "FIGHT_PROP_FIRE_ADD_HURT": "火元素伤害加成", "FIGHT_PROP_ELEC_ADD_HURT": "雷元素伤害加成",
    "FIGHT_PROP_WATER_ADD_HURT": "水元素伤害加成", "FIGHT_PROP_GRASS_ADD_HURT": "草元素伤害加成",
    "FIGHT_PROP_WIND_ADD_HURT": "风元素伤害加成", "FIGHT_PROP_ROCK_ADD_HURT": "岩元素伤害加成",
    "FIGHT_PROP_ICE_ADD_HURT": "冰元素伤害加成", "FIGHT_PROP_PHYSICAL_ADD_HURT": "物理伤害加成",
}
ENKA_RELICS_URL = "https://gcore.jsdelivr.net/gh/EnkaNetwork/API-docs@master/store/gi/relics.json"


def fetch_url_lines(url, timeout=15):
    """多线路抓取：直连 → cors.lol → allorigins → codetabs，逐条尝试"""
    attempts = [
        url,
        "https://api.cors.lol/?url=" + urllib.parse.quote(url, safe=""),
        "https://api.allorigins.win/raw?url=" + urllib.parse.quote(url, safe=""),
        "https://api.codetabs.com/v1/proxy?quest=" + url,
    ]
    errs = []
    for u in attempts:
        try:
            req = urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0 genshin-roster/1.0"})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read()
        except Exception as e:
            errs.append(u.split("/")[2] + ": " + str(e)[:60])
    raise RuntimeError("所有线路均失败 → " + "；".join(errs))


def load_static():
    """Enka 静态数据：zh 名字表 + 角色元数据（天赋顺序）+ 武器表 + 套装表。7 天缓存，失败读旧缓存"""
    cache = None
    if os.path.exists(ENKA_LOCS_CACHE):
        try:
            cache = json.load(open(ENKA_LOCS_CACHE, encoding="utf-8"))
            if time.time() - cache.get("ts", 0) < STATIC_TTL and "sets" in cache:
                return cache["zh"], cache["meta"], cache["weapons"], cache["sets"]
        except Exception:
            pass
    try:
        zh = json.loads(fetch_url_lines(ENKA_LOC_URL).decode("utf-8"))["zh-cn"]
        meta = json.loads(fetch_url_lines(ENKA_AVATAR_URL).decode("utf-8"))
        weapons = json.loads(fetch_url_lines(ENKA_WEAPON_URL).decode("utf-8"))
        sets = json.loads(fetch_url_lines(ENKA_RELICS_URL).decode("utf-8")).get("Sets") or {}
    except Exception as e:
        if cache and "sets" in cache:
            return cache["zh"], cache["meta"], cache["weapons"], cache["sets"]
        raise RuntimeError(f"Enka 静态数据获取失败（{e}）")
    with open(ENKA_LOCS_CACHE, "w", encoding="utf-8") as f:
        json.dump({"ts": time.time(), "zh": zh, "meta": meta, "weapons": weapons, "sets": sets}, f, ensure_ascii=False)
    return zh, meta, weapons, sets


def parse_enka(raw_json):
    """Enka 展柜 JSON → 应用格式 {characters, pool}（前端确认/写入流程专用）"""
    zh, meta, weapons, sets = load_static()
    data = json.loads(raw_json)
    avlist = data.get("avatarInfoList") or []
    if not avlist:
        raise RuntimeError("该 UID 没有公开的展柜数据——请在游戏内「设置 → 展柜」设为公开后重试")
    characters, pool = [], []
    for av in avlist:
        aid = str(av.get("avatarId") or av.get("avatarID") or "")
        m = meta.get(aid) or {}
        name = zh.get(str(m.get("NameTextMapHash"))) or ("未知角色#" + aid)
        level = int(float((av.get("propMap") or {}).get("4001", {}).get("val", 1)))
        rec = {"name": name, "level": level, "constellation": len(av.get("talentIdList") or []),
               "role": "", "notes": "", "weaponCopy": 1, "weapon": "待定", "weaponLevel": None}
        sl = av.get("skillLevelMap") or {}
        extra = av.get("proudSkillExtraLevelMap") or {}
        order = m.get("SkillOrder") or []
        if len(order) >= 3:
            rec["talents"] = [int(sl.get(str(s), 1)) + int(extra.get(str(s), 0)) for s in order[:3]]
        for eq in av.get("equipList") or []:
            flat = eq.get("flat") or {}
            itype = flat.get("itemType") or ""
            if itype == "ITEM_WEAPON":
                wh = zh.get(str(flat.get("nameTextMapHash")))
                if not wh:                                   # 兜底：itemId → weapons.json → hash → 名字
                    wm = weapons.get(str(eq.get("itemId"))) or {}
                    wh = zh.get(str(wm.get("NameTextMapHash")))
                rec["weapon"] = wh or ("未知武器#" + str(eq.get("itemId")))
                rec["weaponLevel"] = (eq.get("weapon") or {}).get("level")
            elif itype == "ITEM_RELIQUARY":
                slot = EQUIP_SLOT.get(flat.get("equipType") or "")
                if not slot:
                    continue
                subs = []
                for s in flat.get("reliquarySubstats") or []:
                    k = SUBSTAT_MAP.get(s.get("appendPropId") or s.get("appendPropID") or "")
                    v = float(s.get("statValue") or s.get("propValue") or 0)
                    if k and v > 0:
                        subs.append({"t": k, "v": round(v, 1)})
                if subs:
                    main = MAIN_MAP.get((flat.get("reliquaryMainstat") or {}).get("mainPropId") or "")
                    # Enka 圣遗物等级 1~21 对应游戏 +0~+20
                    lv = max(0, int((eq.get("reliquary") or {}).get("level", 1)) - 1)
                    sm = sets.get(str(flat.get("setId"))) or {}
                    set_name = zh.get(str(sm.get("Name")))
                    pool.append({"slot": slot, "owner": name, "sub": subs, "main": main,
                                 "lv": lv, "set": set_name})
        characters.append(rec)
    return characters, pool


# ---------------- 展柜缓存（6 小时） ----------------
def uid_cache_get(uid, refresh):
    if os.path.exists(ENKA_UID_CACHE) and not refresh:
        try:
            c = json.load(open(ENKA_UID_CACHE, encoding="utf-8"))
            e = c.get(str(uid))
            if e and time.time() - e["ts"] < UID_CACHE_TTL:
                return e["data"]
        except Exception:
            pass
    return None


def uid_cache_put(uid, data):
    try:
        c = {}
        if os.path.exists(ENKA_UID_CACHE):
            try:
                c = json.load(open(ENKA_UID_CACHE, encoding="utf-8"))
            except Exception:
                pass
        c[str(uid)] = {"ts": time.time(), "data": data}
        with open(ENKA_UID_CACHE, "w", encoding="utf-8") as f:
            json.dump(c, f, ensure_ascii=False)
    except Exception:
        pass


# ---------------- 百度网盘云端同步（个人开放平台 API） ----------------
# 机制：百度同步密钥.txt（两行 AppKey/SecretKey）→ OAuth 授权码换 token（凭证存百度凭证.json，
# 自动刷新）→ 云端 /apps/专属目录/genshin-roster-backup.json 与本机 db 互相同步。
# 决策在网页端做（比较云端 mtime 与本机记录），助手只提供 pull/push 原子操作。
BAIDU_KEY_FILE = os.path.join(HERE, "baidu-keys.txt")            # 兼容旧中文名：百度同步密钥.txt
BAIDU_KEY_FILE_OLD = os.path.join(HERE, "百度同步密钥.txt")
BAIDU_CRED_FILE = os.path.join(HERE, "baidu-credential.json")     # 兼容旧中文名：百度凭证.json
BAIDU_OAUTH = "https://openapi.baidu.com/oauth/2.0"
BAIDU_API = "https://pan.baidu.com/rest/2.0"               # 注意：路径 qs 以 /xpan/ 开头，这里不能带 xpan
BAIDU_REDIRECT = "https://openapi.baidu.com/oauth/2.0/login_success"   # 桌面应用标准回跳页（显示授权码）
CLOUD_BACKUP_NAME = "genshin-roster-backup.json"
BAIDU_CLOUD_DIR = "/apps/原神养成记录"              # 应用专属目录（=创建应用时的应用名称，百度限制只能读写这里）


def baidu_keys():
    """读密钥文件：两行 AppKey / SecretKey，容忍 'AppKey: xxx' 标签前缀"""
    try:
        keyfile = BAIDU_KEY_FILE if os.path.exists(BAIDU_KEY_FILE) else BAIDU_KEY_FILE_OLD
        lines = [l.strip() for l in open(keyfile, encoding="utf-8") if l.strip()]
        vals = []
        for l in lines:
            v = l
            for kw in ("AppKey", "SecretKey", "Secret", "Key"):
                if v.lower().startswith(kw.lower()) and (len(v) == len(kw) or not v[len(kw)].isalnum()):
                    v = v[len(kw):].lstrip(" :：=").strip().strip('"\'')
                    break
            if v:
                vals.append(v)
        if len(vals) >= 2 and vals[0] and vals[1]:
            return vals[0], vals[1]
    except Exception:
        pass
    return None


def baidu_cred():
    try:
        credfile = BAIDU_CRED_FILE if os.path.exists(BAIDU_CRED_FILE) else os.path.join(HERE, "百度凭证.json")
        return json.load(open(credfile, encoding="utf-8"))
    except Exception:
        return None


def baidu_save_cred(d):
    with open(BAIDU_CRED_FILE, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False, indent=2)


def baidu_token():
    """返回可用 access_token；过期自动用 refresh_token 续期。失败返回 (None, 错误)"""
    cred = baidu_cred()
    if not cred:
        return None, "尚未授权"
    if time.time() < cred.get("expires_at", 0) - 60:
        return cred["access_token"], None
    keys = baidu_keys()
    if not keys:
        return None, "缺少 百度同步密钥.txt"
    try:
        url = (f"{BAIDU_OAUTH}/token?grant_type=refresh_token&refresh_token={cred['refresh_token']}"
               f"&client_id={keys[0]}&client_secret={keys[1]}")
        r = json.loads(urllib.request.urlopen(urllib.request.Request(url), timeout=20).read().decode("utf-8"))
        if r.get("access_token"):
            cred.update({"access_token": r["access_token"],
                         "refresh_token": r.get("refresh_token", cred["refresh_token"]),
                         "expires_at": time.time() + r.get("expires_in", 2592000)})
            baidu_save_cred(cred)
            return cred["access_token"], None
        return None, "刷新失败：" + str(r.get("error_description", r.get("error", r)))
    except Exception as e:
        return None, f"刷新请求失败：{e}"


def baidu_api_get(qs, token, retries=2):
    """GET 百度 API；百度的 xpan 接口会间歇性返回 404/超时（实测），自动重试 2 次。
       HTTPError 时把响应体里的 errno/message 提出来，错误信息可读"""
    url = f"{BAIDU_API}{qs}{'&' if '?' in qs else '?'}access_token={token}"
    last = ""
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "genshin-roster/1.0"})
            return json.loads(urllib.request.urlopen(req, timeout=30).read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            body = ""
            try: body = e.read().decode("utf-8", "replace")[:200]
            except Exception: pass
            last = f"HTTP {e.code}：{body}"
            if e.code not in (404, 500, 502, 503): break   # 只有疑似瞬时错误才重试
        except Exception as e:
            last = str(e)
        if attempt < retries:
            time.sleep(1.5)
    raise RuntimeError("百度接口请求失败（已重试）：" + last)


def baidu_app_dirs(token):
    r = baidu_api_get("/xpan/file?method=list&dir=/apps&web=1", token)
    if r.get("errno") != 0:
        raise RuntimeError("列出 /apps 失败 errno=" + str(r.get("errno")))
    return [x["path"] for x in (r.get("list") or []) if x.get("isdir")]


def baidu_find_cloud_backup(token):
    """定位云端备份文件 → (path, server_mtime) 或 (None, None)。
       优先直查专属目录 /apps/原神养成记录/（应用名），失败再退回全目录扫描"""
    direct = BAIDU_CLOUD_DIR + "/" + CLOUD_BACKUP_NAME
    try:
        paths = json.dumps([direct])
        r = baidu_api_get("/xpan/filemetas?access_token=1&paths=" + urllib.parse.quote(paths) + "&dlink=0", token)
        if r.get("errno") == 0:
            lst = (r.get("info") or [])
            if lst and not lst[0].get("isdir"):
                return lst[0]["path"], lst[0].get("server_mtime")
    except Exception:
        pass
    try:
        for d in baidu_app_dirs(token):
            try:
                for x in baidu_api_get(f"/xpan/file?method=list&dir={urllib.parse.quote(d)}&web=1", token).get("list") or []:
                    if not x.get("isdir") and x.get("server_filename") == CLOUD_BACKUP_NAME:
                        return x["path"], x.get("server_mtime")
            except Exception:
                continue                                     # 单个目录列举失败不影响整体
    except Exception:
        pass
    return None, None


def baidu_download(token, path):
    url = f"{BAIDU_API}/xpan/file?method=download&access_token={token}&path={urllib.parse.quote(path)}"
    req = urllib.request.Request(url, headers={"User-Agent": "netdisk;genshin-roster/1.0"})
    return urllib.request.urlopen(req, timeout=60).read()


def baidu_upload(token, content):
    """单步上传（官方"单步上传"接口，≤4MB 文件专用，覆盖写）到 /apps/专属目录。返回 server_mtime。
       注意：不能用三步式 precreate/superfile/create（实测会踩 IDC 路由 403/-11015、internal error 等坑）"""
    target = BAIDU_CLOUD_DIR + "/" + CLOUD_BACKUP_NAME
    path_q = urllib.parse.quote(target)
    boundary = "----genshinroster" + str(int(time.time() * 1000))
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{CLOUD_BACKUP_NAME}\"\r\n"
            f"Content-Type: application/octet-stream\r\n\r\n").encode() + content + f"\r\n--{boundary}--\r\n".encode()
    url = (f"{BAIDU_API}/xpan/file?method=upload&access_token={token}"
           f"&path={path_q}&ondup=overwrite")                      # ondup=overwrite：冲突覆盖，不产生副本
    last = ""
    for attempt in range(3):                                       # 百度接口间歇性 400/404/5xx，重试 2 次
        try:
            req = urllib.request.Request(url, data=body, method="POST",
                                 headers={"User-Agent": "genshin-roster/1.0",
                                          "Content-Type": "multipart/form-data; boundary=" + boundary})
            r = json.loads(urllib.request.urlopen(req, timeout=60).read().decode("utf-8"))
            if r.get("errno") not in (0, None):
                raise RuntimeError("上传失败 errno=" + str(r.get("errno")))
            return r.get("mtime") or int(time.time())
        except urllib.error.HTTPError as e:
            detail = ""
            try: detail = e.read().decode("utf-8", "replace")[:150]
            except Exception: pass
            last = f"HTTP {e.code}：{detail}"
        except Exception as e:
            last = str(e)
        if attempt < 2:
            time.sleep(2)
    raise RuntimeError("上传失败（已重试）：" + last)


# ---------------- 抽卡记录同步（读游戏缓存 → 米哈游祈愿 API） ----------------
# 原理：游戏内打开「祈愿历史记录」页面时，本机会留下带 authkey 的请求 URL（存于 webCaches 缓存，
#       约 24 小时有效）；助手从缓存提取 URL → 调官方祈愿接口分页拉取全部记录。authkey 只在本机使用。
GACHA_CACHE_BASE = os.path.join(os.environ.get("LOCALAPPDATA", ""), "Low", "miHoYo", "原神", "webCaches")
GACHA_TYPES = [301, 302, 200, 500, 100]        # 角色活动/武器活动/常驻/集录/新手
GACHA_JOB = {"running": False, "done": False, "error": None, "records": None, "fetched": 0, "log": []}

def gacha_find_url():
    """从游戏 webCaches 里提取最近一次的祈愿历史 URL（含 authkey）→ (url, None) 或 (None, 错误)"""
    base = GACHA_CACHE_BASE
    if not os.path.isdir(base):
        return None, "没找到游戏缓存目录（原神需要装在这台电脑上）：" + base
    best = None
    for ver in os.listdir(base):
        f = os.path.join(base, ver, "Cache_Data", "data_2")
        if os.path.isfile(f) and (best is None or ver > best[0]):
            best = (ver, f)
    if not best:
        return None, "缓存目录里没有 data_2 文件"
    try:
        data = open(best[1], "rb").read().decode("utf-8", "replace")
    except Exception as e:
        return None, "读取缓存失败：" + str(e)
    urls = re.findall(r'https://public-operation-hk4e\.mihoyo\.com/gacha_info/api/getGachaLog[^\s"\'\\]*', data)
    if not urls:
        return None, "缓存里没有抽卡记录 URL——请先在游戏里打开一次「祈愿历史记录」页面，再回来点同步"
    return urls[-1].replace("&", "&"), None


def gacha_fetch_all(url, known_ids, progress_cb=None):
    """按 5 种卡池分页拉取全部祈愿记录；增量：某页全部 id 已知则该池提前结束"""
    p = urllib.parse.urlparse(url)
    base = f"{p.scheme}://{p.netloc}{p.path}"
    params = {k: v[0] for k, v in urllib.parse.parse_qs(p.query).items()}
    out = []
    for gtype in GACHA_TYPES:
        end_id = "0"
        while True:
            q = dict(params)
            q.update({"gacha_type": str(gtype), "size": "20", "end_id": end_id})
            u = base + "?" + urllib.parse.urlencode(q)
            req = urllib.request.Request(u, headers={"User-Agent": "genshin-roster/1.0"})
            r = json.loads(urllib.request.urlopen(req, timeout=20).read().decode("utf-8"))
            if r.get("retcode") != 0:
                raise RuntimeError(f"祈愿接口 retcode={r.get('retcode')}：请先在游戏里重新打开一次「祈愿历史记录」页面（authkey 约 24 小时过期）")
            lst = (r.get("data") or {}).get("list") or []
            out.extend(lst)
            if progress_cb:
                progress_cb(gtype, len(out))
            if len(lst) < 20:
                break
            if known_ids and all(x.get("id") in known_ids for x in lst):
                break                                    # 本页全是已知记录，增量结束
            end_id = lst[-1]["id"]
            time.sleep(0.15)                             # 礼貌限速
    return out


def gacha_job_start(known_ids):
    if GACHA_JOB["running"]:
        return
    GACHA_JOB.update({"running": True, "done": False, "error": None, "records": None, "fetched": 0, "log": []})
    def work():
        try:
            url, err = gacha_find_url()
            if err:
                raise RuntimeError(err)
            known = set(known_ids or [])
            def cb(pool, total):
                GACHA_JOB["log"] = (GACHA_JOB["log"] + [f"卡池{pool} 已取 {total} 条"])[-5:]
                GACHA_JOB["fetched"] = total
            recs = gacha_fetch_all(url, known, cb)
            GACHA_JOB.update({"done": True, "records": recs, "fetched": len(recs)})
        except Exception as e:
            GACHA_JOB.update({"done": True, "error": str(e)})
        finally:
            GACHA_JOB["running"] = False
    threading.Thread(target=work, daemon=True).start()


# ---------------- HTTP 服务器 ----------------
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):          # 静默访问日志
        pass

    def _json(self, obj, code=200):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _html_file(self, path):
        try:
            with open(path, "rb") as f:
                data = f.read()
        except Exception:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")   # 禁止缓存，防止用到旧版本页面
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)
        if path in ("/", "/index.html"):
            self._html_file(INDEX_HTML)
        elif path == "/af-sets-data.js":
            # 数据文件：打包后在 _MEIPASS，源码运行时在脚本目录
            fname = os.path.join(BASE, path.lstrip("/"))
            if not os.path.exists(fname):
                fname = os.path.join(HERE, path.lstrip("/"))
            try:
                with open(fname, "rb") as f:
                    data = f.read()
            except Exception:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/javascript; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        elif path == "/ping":
            self._json({"helper": True})
        elif path == "/uid/sync":
            # UID 展柜同步（Enka，无需登录；多线路抓取 + 6 小时缓存，?refresh=1 强制刷新）
            try:
                uid = qs.get("uid", [""])[0].strip()
                if not uid.isdigit():
                    raise RuntimeError("UID 必须是 9 位数字")
                refresh = qs.get("refresh", ["0"])[0] == "1"
                cached = uid_cache_get(uid, refresh)
                if cached:
                    chars, pool = cached["characters"], cached["pool"]
                else:
                    raw = fetch_url_lines(ENKA_UID_URL + uid)
                    chars, pool = parse_enka(raw.decode("utf-8"))
                    uid_cache_put(uid, {"characters": chars, "pool": pool})
                self._json({"ok": True, "characters": chars, "pool": pool})
            except Exception as e:
                self._json({"ok": False, "error": str(e)})
        elif path == "/baidu/status":
            keys = baidu_keys()
            cred = baidu_cred()
            self._json({"hasKey": bool(keys), "authorized": bool(cred and cred.get("access_token")),
                        "expires_at": (cred or {}).get("expires_at")})
        elif path == "/baidu/authorize-url":
            keys = baidu_keys()
            if not keys:
                self._json({"ok": False, "error": "缺少 百度同步密钥.txt"}); return
            qs2 = urllib.parse.urlencode({"response_type": "code", "client_id": keys[0],
                "redirect_uri": BAIDU_REDIRECT, "scope": "basic,netdisk", "display": "page"})
            self._json({"ok": True, "url": BAIDU_OAUTH + "/authorize?" + qs2})
        elif path == "/baidu/callback":
            code = qs.get("code", [""])[0]
            keys = baidu_keys()
            try:
                if not code: raise RuntimeError("缺少授权码")
                ex_url = (f"{BAIDU_OAUTH}/token?grant_type=authorization_code&code={code}"
                          f"&client_id={keys[0]}&client_secret={keys[1]}&redirect_uri={BAIDU_REDIRECT}")
                r = json.loads(urllib.request.urlopen(urllib.request.Request(ex_url), timeout=20).read().decode("utf-8"))
                if not r.get("access_token"):
                    raise RuntimeError(str(r.get("error_description", r.get("error", "换token失败"))))
                baidu_save_cred({"access_token": r["access_token"], "refresh_token": r.get("refresh_token", ""),
                                 "expires_at": time.time() + r.get("expires_in", 2592000)})
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.end_headers()
                self.wfile.write("<meta charset='utf-8'><body style='text-align:center;margin-top:80px;'><h2>✅ 百度网盘授权成功</h2><p>请回到本页面刷新状态，然后关闭此窗口。</p></body>".encode("utf-8"))
            except Exception as e:
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.end_headers()
                self.wfile.write(("<meta charset='utf-8'><body style='text-align:center;margin-top:80px;'><h2>❌ 授权失败</h2><p>" + str(e).replace("<", "&lt;") + "</p><p>请关闭此窗口重试。</p></body>").encode("utf-8"))
        elif path == "/baidu/cloud-info":
            try:
                token, err = baidu_token()
                if err: raise RuntimeError(err)
                p, m = baidu_find_cloud_backup(token)
                self._json({"ok": True, "mtime": m})
            except Exception as e:
                self._json({"ok": False, "error": str(e)})
        elif path == "/baidu/pull":
            try:
                token, err = baidu_token()
                if err: raise RuntimeError(err)
                p, m = baidu_find_cloud_backup(token)
                if not p: raise RuntimeError("云端还没有备份文件")
                content = baidu_download(token, p).decode("utf-8")
                self._json({"ok": True, "content": content, "mtime": m})
            except Exception as e:
                self._json({"ok": False, "error": str(e)})
        elif path == "/gacha/progress":
            self._json({"ok": True, "running": GACHA_JOB["running"], "done": GACHA_JOB["done"],
                        "fetched": GACHA_JOB["fetched"], "log": GACHA_JOB["log"][-3:],
                        "error": GACHA_JOB["error"],
                        "records": (GACHA_JOB["records"] if GACHA_JOB["done"] and not GACHA_JOB["error"] else None)})
        else:
            self.send_error(404)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/gacha/sync":
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
            gacha_job_start([str(x) for x in (body.get("known_ids") or [])])
            self._json({"ok": True, "started": True})
        elif parsed.path == "/baidu/exchange":
            keys = baidu_keys()
            try:
                if not keys: raise RuntimeError("缺少 百度同步密钥.txt")
                length = int(self.headers.get("Content-Length", 0))
                body = json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
                code = str(body.get("code", "")).strip()
                if not code: raise RuntimeError("缺少授权码")
                ex_url = (f"{BAIDU_OAUTH}/token?grant_type=authorization_code&code={code}"
                          f"&client_id={keys[0]}&client_secret={keys[1]}&redirect_uri={BAIDU_REDIRECT}")
                r = json.loads(urllib.request.urlopen(urllib.request.Request(ex_url), timeout=20).read().decode("utf-8"))
                if not r.get("access_token"):
                    raise RuntimeError(str(r.get("error_description", r.get("error", "换token失败"))))
                baidu_save_cred({"access_token": r["access_token"], "refresh_token": r.get("refresh_token", ""),
                                 "expires_at": time.time() + r.get("expires_in", 2592000)})
                self._json({"ok": True})
            except Exception as e:
                self._json({"ok": False, "error": str(e)})
        elif parsed.path == "/baidu/push":
            try:
                token, err = baidu_token()
                if err: raise RuntimeError(err)
                length = int(self.headers.get("Content-Length", 0))
                body = json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
                content = str(body.get("content", "")).encode("utf-8")
                if not content: raise RuntimeError("内容为空")
                mtime = baidu_upload(token, content)
                self._json({"ok": True, "mtime": mtime})
            except Exception as e:
                self._json({"ok": False, "error": str(e)})
        elif parsed.path == "/shutdown":
            self._json({"ok": True, "message": "助手即将退出"})
            threading.Thread(target=SERVER.shutdown, daemon=True).start()
        else:
            self.send_error(404)


class HelperServer(ThreadingHTTPServer):
    daemon_threads = True
    def handle_error(self, request, client_address):
        pass                            # 客户端断开等异常静默（stderr 写满管道会阻塞整个服务）


SERVER = None

def open_app_window():
    """用 Edge/Chrome 的应用模式打开（无地址栏，看起来像独立软件）"""
    url = f"http://127.0.0.1:{PORT}"
    for path in [
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    ]:
        if os.path.exists(path):
            subprocess.Popen([path, f"--app={url}", f"--window-size=1280,900"])
            return
    webbrowser.open(url)                     # 兜底：默认浏览器

def main():
    global SERVER
    import socket
    probe = socket.socket()
    port_busy = probe.connect_ex(("127.0.0.1", PORT)) == 0
    probe.close()
    open_app_window()                        # 先开窗口（含已运行的情况）
    if port_busy:
        print("助手已在运行，仅重新打开窗口")
        return
    SERVER = HelperServer(("127.0.0.1", PORT), Handler)
    SERVER.serve_forever()


if __name__ == "__main__":
    main()
