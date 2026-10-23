import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  View, Text, TextInput, ScrollView, KeyboardAvoidingView, Platform,
  StyleSheet, Animated, Easing, Keyboard, Dimensions, Pressable, Image,
  BackHandler, ActivityIndicator, Modal, Switch, useColorScheme, AppState,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as ImagePicker from 'expo-image-picker';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system/legacy';
import { useVideoPlayer, VideoView } from 'expo-video';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';

// ---------- Firebase ----------
const API_KEY = 'AIzaSyA4SPK_DVivGqseSwzCSFxBTCytb3AU68k';
const PROJECT = 'messenger-a8377';
const ROOT = 'projects/' + PROJECT + '/databases/(default)/documents';
const FS = 'https://firestore.googleapis.com/v1/' + ROOT;
const AUTH = 'https://identitytoolkit.googleapis.com/v1/accounts:';
const SESSION_KEY = 'messenger.session.v1';
const PREFS_KEY = 'messenger.prefs.v1';
const LOGIN_DOMAIN = '@duo-messenger.app';

const VIDEO_MAX_SEC = 10;
const VIDEO_MAX_BYTES = 8 * 1024 * 1024;
const CHUNK = 900000;

const enc = (v) => {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'number') return { integerValue: String(Math.round(v)) };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
  return { stringValue: String(v) };
};
const dec = (v) => {
  if (!v) return undefined;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(dec);
  return undefined;
};
const fields = (obj) => {
  const f = {};
  Object.keys(obj).forEach((k) => { f[k] = enc(obj[k]); });
  return f;
};
const unpack = (doc) => {
  const o = { path: doc.name, id: doc.name.split('/').pop() };
  const f = doc.fields || {};
  Object.keys(f).forEach((k) => { o[k] = dec(f[k]); });
  return o;
};
const mask = (keys) => keys.map((k) => 'updateMask.fieldPaths=' + encodeURIComponent(k)).join('&');

// Логин -> внутренняя почта Firebase. Старые аккаунты входят по своей почте.
const loginToEmail = (l) => {
  const v = l.trim().toLowerCase();
  return v.includes('@') ? v : v + LOGIN_DOMAIN;
};
const LOGIN_RE = /^[a-z0-9_.]{3,20}$/;

const AUTH_ERR = {
  EMAIL_EXISTS: 'Этот логин уже занят. Придумайте другой.',
  EMAIL_NOT_FOUND: 'Аккаунт не найден.',
  INVALID_PASSWORD: 'Неверный пароль.',
  INVALID_LOGIN_CREDENTIALS: 'Неверный логин или пароль.',
  INVALID_EMAIL: 'Логин содержит недопустимые символы.',
  USER_DISABLED: 'Аккаунт отключён.',
  TOO_MANY_ATTEMPTS_TRY_LATER: 'Слишком много попыток. Подождите немного.',
};
const authError = (m) => {
  const key = String(m || '').split(' ')[0].split(':')[0];
  if (key.startsWith('WEAK_PASSWORD')) return 'Пароль слишком короткий: нужно минимум 6 символов.';
  return AUTH_ERR[key] || m;
};

async function authCall(method, body) {
  const res = await fetch(AUTH + method + '?key=' + API_KEY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, returnSecureToken: true }),
  });
  const data = await res.json();
  if (data.error) throw new Error(authError(data.error.message));
  return data;
}

async function refreshToken(refresh) {
  const res = await fetch('https://securetoken.googleapis.com/v1/token?key=' + API_KEY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(refresh),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'refresh failed');
  return { idToken: data.id_token, refreshToken: data.refresh_token, exp: Date.now() + Number(data.expires_in) * 1000 - 60000 };
}

const chatIdOf = (a, b) => [a, b].sort().join('_');
const fmtTime = (ts) => {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  if (d.toDateString() === now.toDateString()) return hm;
  return String(d.getDate()).padStart(2, '0') + '.' + String(d.getMonth() + 1).padStart(2, '0') + ' ' + hm;
};
const fmtDur = (sec) => '0:' + String(Math.max(1, Math.round(sec || 0))).padStart(2, '0');
const shown = (p) => (p && (p.nick || p.name)) || '';

// ---------- Уведомления ----------
try {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: AppState.currentState !== 'active',
      shouldShowList: true,
      shouldPlaySound: AppState.currentState !== 'active',
      shouldSetBadge: false,
    }),
  });
} catch (e) {}

const projectId = () => {
  const c = Constants.expoConfig || {};
  return (c.extra && c.extra.eas && c.extra.eas.projectId) || (Constants.easConfig && Constants.easConfig.projectId) || '';
};

async function getPushToken() {
  if (Platform.OS === 'web') return '';
  const pid = projectId();
  if (!pid) return '';
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'Сообщения',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 200, 120, 200],
    });
  }
  let { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted') status = (await Notifications.requestPermissionsAsync()).status;
  if (status !== 'granted') return '';
  const t = await Notifications.getExpoPushTokenAsync({ projectId: pid });
  return t.data || '';
}

async function pushTo(token, title, body, data) {
  if (!token) return;
  try {
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ to: token, title, body, data, sound: 'default', channelId: 'default', priority: 'high' }),
    });
  } catch (e) {}
}

// ---------- Темы ----------
const THEMES = {
  light: {
    dark: false,
    stops: [[65, 113, 154], [109, 126, 122], [232, 192, 112]],
    blobs: ['rgba(255,255,255,0.18)', 'rgba(255,214,120,0.22)', 'rgba(40,80,140,0.20)'],
    card: 'rgba(255,248,230,0.93)',
    text: '#222',
    sub: '#7b7466',
    ph: '#8a8470',
    mine: 'rgba(255,248,230,0.97)',
    theirs: 'rgba(255,255,255,0.72)',
    accent: '#1c1c1e',
    onAccent: '#fff',
    tabBar: 'rgba(255,255,255,0.42)',
    tabText: '#42525e',
    soft: 'rgba(0,0,0,0.06)',
    edge: 'rgba(255,255,255,0.75)',
    edgeLow: 'rgba(0,0,0,0.14)',
    header: 'rgba(255,248,230,0.9)',
  },
  dark: {
    dark: true,
    stops: [[16, 20, 30], [24, 30, 44], [44, 38, 52]],
    blobs: ['rgba(120,140,200,0.10)', 'rgba(200,160,90,0.08)', 'rgba(70,110,190,0.12)'],
    card: 'rgba(38,40,50,0.94)',
    text: '#ececf1',
    sub: '#9a9aa8',
    ph: '#777784',
    mine: 'rgba(64,86,140,0.96)',
    theirs: 'rgba(52,54,66,0.96)',
    accent: '#ece6d6',
    onAccent: '#15161a',
    tabBar: 'rgba(36,38,48,0.88)',
    tabText: '#a9adbd',
    soft: 'rgba(255,255,255,0.08)',
    edge: 'rgba(255,255,255,0.10)',
    edgeLow: 'rgba(0,0,0,0.3)',
    header: 'rgba(30,32,42,0.92)',
  },
};
const AV_COLORS = ['#25272b', '#3b6fd6', '#2e9d6a', '#d9534f', '#e08a2c', '#8e5bd6', '#d6457f', '#2aa3b8'];

const VISC = Easing.bezier(0.22, 0.9, 0.3, 1);
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const colorAt = (stops, t) => {
  const [a, b, k] = t < 0.5 ? [stops[0], stops[1], t * 2] : [stops[1], stops[2], (t - 0.5) * 2];
  return 'rgb(' + mix(a, b, k).join(',') + ')';
};

const TABS = ['Главная', 'Чат', 'Настройки'];
const EMOJIS = ['❤️', '👍', '😂', '🔥', '😮'];
const W = Dimensions.get('window').width;
const H = Dimensions.get('window').height;
const TAB_W = Math.min(104, Math.floor((W - 56) / 3));
const MEDIA_W = Math.min(230, W * 0.6);
const MEDIA_H = 280;

const mediaSize = (w, h) => {
  const r = w && h ? w / h : 1;
  let width = Math.min(MEDIA_W, MEDIA_H * r);
  let height = width / r;
  if (height < 90) { height = 90; width = Math.min(MEDIA_W, 90 * r); }
  return { width: Math.round(width), height: Math.round(height) };
};

// ---------- Кнопка-жидкость ----------
function Goo({ children, onPress, onLongPress, style, depth }) {
  const sc = useRef(new Animated.Value(1)).current;
  const t0 = useRef(0);
  const sink = depth || 0.94;
  const down = () => {
    t0.current = Date.now();
    Animated.timing(sc, { toValue: sink, duration: 900, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
  };
  const up = () => {
    const strike = Date.now() - t0.current < 180;
    sc.stopAnimation();
    if (strike) {
      Animated.sequence([
        Animated.timing(sc, { toValue: 0.9, duration: 45, easing: Easing.linear, useNativeDriver: true }),
        Animated.spring(sc, { toValue: 1, stiffness: 900, damping: 40, mass: 1, useNativeDriver: true }),
      ]).start();
    } else {
      Animated.timing(sc, { toValue: 1, duration: 1100, easing: VISC, useNativeDriver: true }).start();
    }
  };
  return (
    <Pressable onPressIn={down} onPressOut={up} onPress={onPress} onLongPress={onLongPress} delayLongPress={350}>
      <Animated.View style={[style, { transform: [{ scale: sc }] }]}>{children}</Animated.View>
    </Pressable>
  );
}

function Blob({ size, color, x, y, dx, dy, dur }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(v, { toValue: 1, duration: dur, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(v, { toValue: 0, duration: dur, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ])
    ).start();
  }, []);
  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute', left: x, top: y, width: size, height: size, borderRadius: size / 2,
        backgroundColor: color,
        transform: [
          { translateX: v.interpolate({ inputRange: [0, 1], outputRange: [0, dx] }) },
          { translateY: v.interpolate({ inputRange: [0, 1], outputRange: [0, dy] }) },
          { scale: v.interpolate({ inputRange: [0, 1], outputRange: [1, 1.18] }) },
        ],
      }}
    />
  );
}

function Background({ T }) {
  return (
    <View style={StyleSheet.absoluteFill}>
      {Array.from({ length: 48 }).map((_, i) => (
        <View key={i} style={{ flex: 1, backgroundColor: colorAt(T.stops, i / 47) }} />
      ))}
      <Blob size={260} color={T.blobs[0]} x={-60} y={120} dx={90} dy={60} dur={9000} />
      <Blob size={220} color={T.blobs[1]} x={W - 150} y={380} dx={-80} dy={90} dur={11000} />
      <Blob size={300} color={T.blobs[2]} x={-80} y={560} dx={70} dy={-80} dur={13000} />
    </View>
  );
}

function Screen({ children }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(v, { toValue: 1, duration: 600, easing: VISC, useNativeDriver: true }).start();
  }, []);
  return (
    <Animated.View style={{ flex: 1, opacity: v, transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [20, 0] }) }] }}>
      {children}
    </Animated.View>
  );
}

// ---------- Аватар ----------
function Avatar({ p, size, s }) {
  const sz = size || 40;
  const name = shown(p) || '?';
  const bg = (p && p.color) || AV_COLORS[0];
  if (p && p.avatar) {
    return <Image source={{ uri: 'data:image/jpeg;base64,' + p.avatar }} style={[s.avatarBase, { width: sz, height: sz, borderRadius: sz / 2 }]} />;
  }
  return (
    <View style={[s.avatarBase, { width: sz, height: sz, borderRadius: sz / 2, backgroundColor: bg }]}>
      <Text style={{ color: '#fff', fontSize: sz * 0.42, fontWeight: '700' }}>{name.charAt(0).toUpperCase()}</Text>
    </View>
  );
}

// ---------- Видео-плеер ----------
function VideoPlayer({ uri }) {
  const player = useVideoPlayer(uri, (p) => { p.loop = false; p.play(); });
  return <VideoView player={player} style={{ width: W, height: H * 0.75 }} contentFit="contain" nativeControls />;
}

// ---------- Сообщение ----------
function Message({ m, mine, seen, open, onOpen, onClose, onReact, onMedia, loadingMedia, s, T }) {
  const enter = useRef(new Animated.Value(0)).current;
  const shake = useRef(new Animated.Value(0)).current;
  const pop = useRef(new Animated.Value(m.reaction ? 1 : 0)).current;
  const prev = useRef(m.reaction);

  useEffect(() => {
    Animated.timing(enter, { toValue: 1, duration: 450, easing: VISC, useNativeDriver: true }).start();
  }, []);

  useEffect(() => {
    if (m.reaction && m.reaction !== prev.current) {
      pop.setValue(0);
      Animated.parallel([
        Animated.sequence(
          [-9, 8, -5, 3, 0].map((v) =>
            Animated.timing(shake, { toValue: v, duration: 45, easing: Easing.linear, useNativeDriver: true })
          )
        ),
        Animated.spring(pop, { toValue: 1, stiffness: 900, damping: 45, mass: 1, useNativeDriver: true }),
      ]).start();
    } else if (!m.reaction) {
      pop.setValue(0);
    }
    prev.current = m.reaction;
  }, [m.reaction]);

  const isMedia = !!(m.img || m.video);
  const size = isMedia ? mediaSize(m.w, m.h) : null;

  return (
    <Animated.View
      style={{
        alignSelf: mine ? 'flex-end' : 'flex-start',
        maxWidth: '80%',
        marginBottom: m.reaction ? 16 : 8,
        opacity: enter,
        transform: [
          { translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) },
          { translateX: shake },
        ],
      }}
    >
      {open ? (
        <View style={s.picker}>
          {EMOJIS.map((e) => (
            <Goo key={e} onPress={() => onReact(m, e)} style={s.pickBtn} depth={0.85}>
              <Text style={s.pickEmoji}>{e}</Text>
            </Goo>
          ))}
        </View>
      ) : null}
      <Goo
        onPress={open ? onClose : isMedia && !m.pending ? () => onMedia(m) : undefined}
        onLongPress={onOpen}
        style={[s.bubble, mine ? s.mine : s.theirs, isMedia ? { padding: 4 } : null]}
        depth={0.96}
      >
        {m.img ? (
          <Image source={{ uri: 'data:image/jpeg;base64,' + m.img }} style={[s.media, size]} resizeMode="cover" />
        ) : null}
        {m.video ? (
          <View style={[s.media, size, s.videoTile]}>
            {m.thumb ? <Image source={{ uri: 'data:image/jpeg;base64,' + m.thumb }} style={[StyleSheet.absoluteFill, { borderRadius: 16 }]} resizeMode="cover" /> : null}
            <View style={s.playBtn}>
              {loadingMedia || m.pending ? <ActivityIndicator color="#fff" /> : <Text style={s.playText}>▶</Text>}
            </View>
            <Text style={s.durText}>{fmtDur(m.dur)}</Text>
          </View>
        ) : null}
        {m.text ? <Text style={[s.bubbleText, isMedia ? { paddingHorizontal: 6, paddingTop: 5 } : null]}>{m.text}</Text> : null}
        <Text style={[s.meta, isMedia ? { paddingHorizontal: 6, paddingBottom: 2 } : null]}>
          {fmtTime(m.ts)}{mine ? (m.pending ? '  ·' : seen ? '  ✓✓' : '  ✓') : ''}
        </Text>
      </Goo>
      {m.reaction ? (
        <Animated.View style={[s.badge, mine ? { left: -8 } : { right: -8 }, { transform: [{ scale: pop }] }]}>
          <Text style={{ fontSize: 14 }}>{m.reaction}</Text>
        </Animated.View>
      ) : null}
    </Animated.View>
  );
}

// ---------- Приложение ----------
export default function Root() {
  return (
    <SafeAreaProvider>
      <App />
    </SafeAreaProvider>
  );
}

function App() {
  const ins = useSafeAreaInsets();
  const sys = useColorScheme();
  const [themePref, setThemePref] = useState('system'); // light | dark | system
  const [pushOn, setPushOn] = useState(true);
  const T = THEMES[themePref === 'system' ? (sys === 'dark' ? 'dark' : 'light') : themePref];
  const s = useMemo(() => makeStyles(T, ins), [T, ins.top, ins.bottom]);

  const [booting, setBooting] = useState(true);
  const [user, setUser] = useState(null); // { uid, email, login, name, nick, idToken, refreshToken, exp }
  const userRef = useRef(null);
  const [me, setMe] = useState(null); // профиль из Firestore
  const [needSetup, setNeedSetup] = useState(false);

  const [mode, setMode] = useState('signup');
  const [fLogin, setFLogin] = useState('');
  const [fPass, setFPass] = useState('');
  const [fName, setFName] = useState('');
  const [fNick, setFNick] = useState('');
  const [busy, setBusy] = useState(false);

  const [tab, setTab] = useState('Главная');
  const [status, setStatus] = useState('');
  const [chats, setChats] = useState([]);
  const [profiles, setProfiles] = useState({});
  const profilesRef = useRef({});
  const [chat, setChat] = useState(null);
  const [messages, setMessages] = useState([]);
  const [findLogin, setFindLogin] = useState('');
  const [text, setText] = useState('');
  const [picker, setPicker] = useState(null);
  const [kb, setKb] = useState(false);
  const [sendingMedia, setSendingMedia] = useState('');
  const [viewer, setViewer] = useState(null); // { img } | { video: uri }
  const [loadingMedia, setLoadingMedia] = useState('');
  const [editOpen, setEditOpen] = useState(false);
  const [edit, setEdit] = useState({});
  const scrollRef = useRef(null);
  const chatRef = useRef(null);

  const ix = useRef(new Animated.Value(0)).current;
  const stretch = useRef(new Animated.Value(1)).current;

  useEffect(() => { userRef.current = user; }, [user]);
  useEffect(() => { chatRef.current = chat; }, [chat]);

  useEffect(() => {
    const a = Keyboard.addListener('keyboardDidShow', () => setKb(true));
    const b = Keyboard.addListener('keyboardDidHide', () => setKb(false));
    return () => { a.remove(); b.remove(); };
  }, []);

  const inChat = tab === 'Чат' && !!chat;

  useEffect(() => {
    const h = BackHandler.addEventListener('hardwareBackPress', () => {
      if (viewer) { setViewer(null); return true; }
      if (editOpen) { setEditOpen(false); return true; }
      if (userRef.current && tab !== 'Главная') { go('Главная'); return true; }
      return false;
    });
    return () => h.remove();
  }, [tab, viewer, editOpen]);

  // ----- Сессия и настройки -----
  const saveSession = async (u) => {
    setUser(u);
    userRef.current = u;
    try {
      if (u) await AsyncStorage.setItem(SESSION_KEY, JSON.stringify(u));
      else await AsyncStorage.removeItem(SESSION_KEY);
    } catch (e) {}
  };
  const savePrefs = async (p) => {
    try { await AsyncStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch (e) {}
  };

  useEffect(() => {
    (async () => {
      try {
        const pr = await AsyncStorage.getItem(PREFS_KEY);
        if (pr) {
          const p = JSON.parse(pr);
          if (p.theme) setThemePref(p.theme);
          if (typeof p.push === 'boolean') setPushOn(p.push);
        }
        const raw = await AsyncStorage.getItem(SESSION_KEY);
        if (raw) {
          const u = JSON.parse(raw);
          setUser(u);
          userRef.current = u;
        }
      } catch (e) {}
      setBooting(false);
    })();
  }, []);

  const token = async () => {
    let u = userRef.current;
    if (!u) throw new Error('Не выполнен вход');
    if (Date.now() > u.exp) {
      const t = await refreshToken(u.refreshToken);
      u = { ...u, ...t };
      await saveSession(u);
    }
    return u.idToken;
  };

  const db = async (url, opts) => {
    const t = await token();
    const res = await fetch(url, {
      ...(opts || {}),
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
    });
    const data = await res.json();
    if (data && data.error) {
      const e = new Error(data.error.message);
      e.code = data.error.code;
      throw e;
    }
    return data;
  };
  const patchUser = async (data) => {
    const u = userRef.current;
    await db(FS + '/users/' + u.uid + '?' + mask(Object.keys(data)), { method: 'PATCH', body: JSON.stringify({ fields: fields(data) }) });
  };

  // Загрузка своего профиля после входа
  useEffect(() => {
    if (!user) return;
    (async () => {
      try {
        const p = unpack(await db(FS + '/users/' + user.uid));
        setMe(p);
        setNeedSetup(!p.name);
      } catch (e) {
        if (e.code === 404) { setMe({ id: user.uid }); setNeedSetup(true); }
      }
    })();
  }, [user && user.uid]);

  // Пуш-токен
  useEffect(() => {
    if (!user || !me) return;
    (async () => {
      try {
        if (pushOn) {
          const t = await getPushToken();
          if (t && t !== me.pushToken) { await patchUser({ pushToken: t }); setMe((p) => ({ ...p, pushToken: t })); }
        } else if (me.pushToken) {
          await patchUser({ pushToken: '' });
          setMe((p) => ({ ...p, pushToken: '' }));
        }
      } catch (e) {}
    })();
  }, [user && user.uid, me && me.id, pushOn]);

  // Нажатие на уведомление открывает нужный чат
  useEffect(() => {
    let sub;
    try {
      sub = Notifications.addNotificationResponseReceivedListener((r) => {
        const cid = r && r.notification && r.notification.request.content.data && r.notification.request.content.data.chatId;
        if (!cid) return;
        const c = chats.find((x) => x.id === cid);
        if (c) openChat(c);
      });
    } catch (e) {}
    return () => { if (sub) sub.remove(); };
  }, [chats]);

  const signUp = async () => {
    const login = fLogin.trim().toLowerCase();
    if (!LOGIN_RE.test(login)) { setStatus('Логин: 3–20 символов, латиница, цифры, точка или _'); return; }
    setBusy(true); setStatus('');
    try {
      const email = loginToEmail(login);
      const d = await authCall('signUp', { email, password: fPass });
      const u = { uid: d.localId, email, login, idToken: d.idToken, refreshToken: d.refreshToken, exp: Date.now() + Number(d.expiresIn) * 1000 - 60000 };
      await saveSession(u);
      await db(FS + '/users/' + u.uid, { method: 'PATCH', body: JSON.stringify({ fields: fields({ login, email, ts: Date.now() }) }) });
    } catch (e) {
      setStatus(e.message);
    }
    setBusy(false);
  };

  const signIn = async () => {
    const raw = fLogin.trim().toLowerCase();
    if (!raw) { setStatus('Введите логин'); return; }
    setBusy(true); setStatus('');
    try {
      const email = loginToEmail(raw);
      const d = await authCall('signInWithPassword', { email, password: fPass });
      const login = raw.includes('@') ? '' : raw;
      await saveSession({ uid: d.localId, email, login, idToken: d.idToken, refreshToken: d.refreshToken, exp: Date.now() + Number(d.expiresIn) * 1000 - 60000 });
    } catch (e) {
      setStatus(e.message);
    }
    setBusy(false);
  };

  const finishSetup = async () => {
    const name = fName.trim();
    const nick = fNick.trim() || name;
    if (!name) { setStatus('Напишите, как вас зовут'); return; }
    setBusy(true); setStatus('');
    try {
      const color = AV_COLORS[Math.floor(Math.random() * AV_COLORS.length)];
      const data = { name, nick, color };
      await patchUser(data);
      setMe((p) => ({ ...p, ...data }));
      setNeedSetup(false);
    } catch (e) {
      setStatus('Не сохранилось: ' + e.message);
    }
    setBusy(false);
  };

  const logout = async () => {
    try { if (me && me.pushToken) await patchUser({ pushToken: '' }); } catch (e) {}
    setChats([]); setChat(null); setMessages([]); setTab('Главная'); ix.setValue(0); setMe(null); setNeedSetup(false);
    setFLogin(''); setFPass(''); setFName(''); setFNick('');
    await saveSession(null);
  };

  // ----- Навигация -----
  const go = (t) => {
    const i = TABS.indexOf(t);
    setTab(t);
    setPicker(null);
    Animated.parallel([
      Animated.timing(ix, { toValue: i * TAB_W, duration: 700, easing: VISC, useNativeDriver: true }),
      Animated.sequence([
        Animated.timing(stretch, { toValue: 1.3, duration: 220, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.timing(stretch, { toValue: 1, duration: 520, easing: VISC, useNativeDriver: true }),
      ]),
    ]).start();
  };

  // ----- Профили собеседников -----
  const loadProfiles = async (ids, force) => {
    const now = Date.now();
    const need = ids.filter((id) => force || !profilesRef.current[id] || now - profilesRef.current[id]._at > 30000);
    if (!need.length) return;
    const got = await Promise.all(need.map(async (id) => {
      try { return { ...unpack(await db(FS + '/users/' + id)), _at: now }; } catch (e) { return null; }
    }));
    const next = { ...profilesRef.current };
    got.forEach((p) => { if (p) next[p.id] = p; });
    profilesRef.current = next;
    setProfiles(next);
  };

  // ----- Список чатов -----
  const loadChats = async () => {
    const u = userRef.current;
    if (!u) return;
    try {
      const rows = await db(FS + ':runQuery', {
        method: 'POST',
        body: JSON.stringify({
          structuredQuery: {
            from: [{ collectionId: 'chats' }],
            where: { fieldFilter: { field: { fieldPath: 'members' }, op: 'ARRAY_CONTAINS', value: { stringValue: u.uid } } },
          },
        }),
      });
      const list = (rows || []).filter((r) => r.document).map((r) => unpack(r.document));
      list.sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
      setChats(list);
      const open = chatRef.current;
      if (open) {
        const fresh = list.find((c) => c.id === open.id);
        if (fresh) setChat(fresh);
      }
      const ids = [];
      list.forEach((c) => (c.members || []).forEach((m) => { if (m !== u.uid && !ids.includes(m)) ids.push(m); }));
      loadProfiles(ids);
      setStatus('');
    } catch (e) {
      setStatus('Нет связи: ' + e.message);
    }
  };

  useEffect(() => {
    if (!user || needSetup) return;
    loadChats();
    const t = setInterval(loadChats, 4000);
    return () => clearInterval(t);
  }, [user && user.uid, needSetup]);

  const otherOf = (c) => {
    const u = userRef.current;
    const id = (c.members || []).find((m) => m !== u.uid) || u.uid;
    const p = profiles[id] || {};
    return { ...p, uid: id, nick: shown(p) || c['n_' + id] || 'Друг' };
  };
  const unread = (c) => {
    const u = userRef.current;
    return c.lastTs && c.lastFrom && c.lastFrom !== u.uid && c.lastTs > (c['r_' + u.uid] || 0);
  };

  // ----- Новый чат по логину -----
  const startChat = async () => {
    const q = findLogin.trim().toLowerCase().replace(/^@/, '');
    const u = userRef.current;
    if (!q) return;
    if (q === u.login || q === u.email) { setStatus('Это вы. Введите логин друга.'); return; }
    setBusy(true); setStatus('');
    try {
      const field = q.includes('@') ? 'email' : 'login';
      const rows = await db(FS + ':runQuery', {
        method: 'POST',
        body: JSON.stringify({
          structuredQuery: {
            from: [{ collectionId: 'users' }],
            where: { fieldFilter: { field: { fieldPath: field }, op: 'EQUAL', value: { stringValue: q } } },
            limit: 1,
          },
        }),
      });
      const found = (rows || []).find((r) => r.document);
      if (!found) { setStatus('Пользователь «' + q + '» не найден.'); setBusy(false); return; }
      const friend = unpack(found.document);
      const id = chatIdOf(u.uid, friend.id);
      let c;
      try {
        c = unpack(await db(FS + '/chats/' + id));
      } catch (e) {
        if (e.code !== 404 && e.code !== 403) throw e;
        const data = { members: [u.uid, friend.id], lastTs: 0, lastText: '', lastFrom: '' };
        data['n_' + u.uid] = shown(me) || u.login;
        data['n_' + friend.id] = shown(friend) || q;
        c = unpack(await db(FS + '/chats/' + id + '?currentDocument.exists=false', { method: 'PATCH', body: JSON.stringify({ fields: fields(data) }) }));
      }
      setFindLogin('');
      openChat(c);
      loadChats();
    } catch (e) {
      setStatus('Не получилось: ' + e.message);
    }
    setBusy(false);
  };

  const openChat = (c) => {
    if (!chatRef.current || chatRef.current.id !== c.id) setMessages([]);
    setChat(c);
    chatRef.current = c;
    go('Чат');
  };

  // ----- Сообщения -----
  const loadMessages = async () => {
    const c = chatRef.current;
    const u = userRef.current;
    if (!c || !u) return;
    try {
      const data = await db(FS + '/chats/' + c.id + '/messages?orderBy=ts%20desc&pageSize=60');
      const list = (data.documents || []).map(unpack).reverse();
      if (chatRef.current && chatRef.current.id === c.id) {
        setMessages((prev) => {
          const pending = prev.filter((m) => m.pending && !list.find((x) => x.cid === m.cid));
          return list.concat(pending);
        });
      }
      const newest = list.length ? list[list.length - 1].ts : 0;
      if (newest && newest > (c['r_' + u.uid] || 0)) {
        const f = {};
        f['r_' + u.uid] = newest;
        await db(FS + '/chats/' + c.id + '?' + mask(['r_' + u.uid]), { method: 'PATCH', body: JSON.stringify({ fields: fields(f) }) });
        const upd = { ...c, ['r_' + u.uid]: newest };
        chatRef.current = upd;
        setChat(upd);
      }
    } catch (e) {
      setStatus('Нет связи: ' + e.message);
    }
  };

  useEffect(() => {
    if (!user || !chat || tab !== 'Чат') return;
    loadMessages();
    const t = setInterval(loadMessages, 2500);
    return () => clearInterval(t);
  }, [user && user.uid, chat && chat.id, tab]);

  const notifyOther = async (c, preview) => {
    const o = otherOf(c);
    await loadProfiles([o.uid], true);
    const p = profilesRef.current[o.uid];
    if (p && p.pushToken) pushTo(p.pushToken, shown(me) || 'Новое сообщение', preview, { chatId: c.id });
  };

  const postMessage = async (data, preview, extraPending) => {
    const c = chatRef.current;
    const u = userRef.current;
    const ts = Date.now();
    const cid = u.uid + '-' + ts;
    const msg = { ...data, from: u.uid, ts, cid };
    setMessages((prev) => prev.concat([{ ...msg, ...(extraPending || {}), id: cid, pending: true }]));
    await db(FS + '/chats/' + c.id + '/messages', { method: 'POST', body: JSON.stringify({ fields: fields(msg) }) });
    const f = { lastText: preview, lastTs: ts, lastFrom: u.uid };
    f['r_' + u.uid] = ts;
    await db(FS + '/chats/' + c.id + '?' + mask(Object.keys(f)), { method: 'PATCH', body: JSON.stringify({ fields: fields(f) }) });
    loadMessages();
    notifyOther(c, preview);
  };

  const send = async () => {
    const t = text.trim();
    if (!t || !chatRef.current) return;
    setText('');
    try {
      await postMessage({ text: t }, t);
    } catch (e) {
      setStatus('Не отправилось: ' + e.message);
    }
  };

  const sendPhotoAsset = async (a) => {
    const big = (a.width || 0) >= (a.height || 0) ? { width: 1000 } : { height: 1000 };
    const r = await manipulateAsync(a.uri, [{ resize: big }], { compress: 0.5, format: SaveFormat.JPEG, base64: true });
    if (!r.base64) throw new Error('не удалось сжать фото');
    if (r.base64.length > 900000) throw new Error('фото слишком большое');
    await postMessage({ img: r.base64, w: r.width, h: r.height, text: '' }, '📷 Фото');
  };

  const sendVideoAsset = async (a) => {
    const dur = (a.duration || 0) / 1000;
    if (dur > VIDEO_MAX_SEC + 0.5) throw new Error('видео длиннее ' + VIDEO_MAX_SEC + ' секунд');
    let size = a.fileSize || 0;
    if (!size) {
      const info = await FileSystem.getInfoAsync(a.uri);
      size = info.size || 0;
    }
    if (size > VIDEO_MAX_BYTES) throw new Error('видео больше 8 МБ (' + (size / 1048576).toFixed(1) + ' МБ)');
    const b64 = await FileSystem.readAsStringAsync(a.uri, { encoding: FileSystem.EncodingType.Base64 });
    const c = chatRef.current;
    const u = userRef.current;
    const mid = u.uid.slice(0, 8) + Date.now();
    const parts = Math.ceil(b64.length / CHUNK);
    for (let i = 0; i < parts; i++) {
      const d = b64.slice(i * CHUNK, (i + 1) * CHUNK);
      await db(FS + '/chats/' + c.id + '/media/' + mid + '_' + i, { method: 'PATCH', body: JSON.stringify({ fields: { d: { stringValue: d } } }) });
    }
    // Копия видео в кэш, чтобы своё видео открывалось без скачивания
    try { await FileSystem.copyAsync({ from: a.uri, to: FileSystem.cacheDirectory + mid + '.mp4' }); } catch (e) {}
    await postMessage({ video: mid, parts, dur: Math.round(dur || 1), w: a.width || 0, h: a.height || 0, text: '' }, '🎬 Видео');
  };

  const sendMedia = async () => {
    if (!chatRef.current || sendingMedia) return;
    try {
      const pick = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images', 'videos'],
        quality: 1,
        videoMaxDuration: VIDEO_MAX_SEC,
      });
      if (pick.canceled || !pick.assets || !pick.assets.length) return;
      const a = pick.assets[0];
      if (a.type === 'video') {
        setSendingMedia('Видео отправляется…');
        await sendVideoAsset(a);
      } else {
        setSendingMedia('Фото отправляется…');
        await sendPhotoAsset(a);
      }
    } catch (e) {
      setStatus('Не отправилось: ' + e.message);
    }
    setSendingMedia('');
  };

  const openMedia = async (m) => {
    if (m.img) { setViewer({ img: m.img, w: m.w, h: m.h }); return; }
    if (!m.video || loadingMedia) return;
    const file = FileSystem.cacheDirectory + m.video + '.mp4';
    try {
      const info = await FileSystem.getInfoAsync(file);
      if (!info.exists) {
        setLoadingMedia(m.id);
        const c = chatRef.current;
        const parts = await Promise.all(
          Array.from({ length: m.parts || 1 }).map((_, i) =>
            db(FS + '/chats/' + c.id + '/media/' + m.video + '_' + i).then((d) => unpack(d).d || '')
          )
        );
        await FileSystem.writeAsStringAsync(file, parts.join(''), { encoding: FileSystem.EncodingType.Base64 });
      }
      setViewer({ video: file });
    } catch (e) {
      setStatus('Видео не открылось: ' + e.message);
    }
    setLoadingMedia('');
  };

  const react = async (m, emoji) => {
    const next = m.reaction === emoji ? '' : emoji;
    setPicker(null);
    setMessages((prev) => prev.map((x) => (x.id === m.id ? { ...x, reaction: next } : x)));
    try {
      await db('https://firestore.googleapis.com/v1/' + m.path + '?' + mask(['reaction']), {
        method: 'PATCH',
        body: JSON.stringify({ fields: { reaction: { stringValue: next } } }),
      });
    } catch (e) {
      setStatus('Реакция не отправилась: ' + e.message);
    }
  };

  // ----- Профиль: редактирование -----
  const openEdit = () => {
    setEdit({ name: (me && me.name) || '', nick: (me && me.nick) || '', color: (me && me.color) || AV_COLORS[0], avatar: (me && me.avatar) || '' });
    setEditOpen(true);
  };
  const pickAvatar = async () => {
    try {
      const pick = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 1 });
      if (pick.canceled || !pick.assets || !pick.assets.length) return;
      const r = await manipulateAsync(pick.assets[0].uri, [{ resize: { width: 256, height: 256 } }], { compress: 0.6, format: SaveFormat.JPEG, base64: true });
      setEdit((e) => ({ ...e, avatar: r.base64 }));
    } catch (e) {
      setStatus('Фото не выбрано: ' + e.message);
    }
  };
  const saveEdit = async () => {
    const name = (edit.name || '').trim();
    if (!name) { setStatus('Имя не может быть пустым'); return; }
    const data = { name, nick: (edit.nick || '').trim() || name, color: edit.color, avatar: edit.avatar || '' };
    setBusy(true);
    try {
      await patchUser(data);
      setMe((p) => ({ ...p, ...data }));
      setEditOpen(false);
      setStatus('');
    } catch (e) {
      setStatus('Не сохранилось: ' + e.message);
    }
    setBusy(false);
  };

  const setTheme = (v) => { setThemePref(v); savePrefs({ theme: v, push: pushOn }); };
  const setPush = (v) => { setPushOn(v); savePrefs({ theme: themePref, push: v }); };

  // ----- Загрузка -----
  if (booting) {
    return (
      <View style={s.root}>
        <Background T={T} />
        <View style={s.center}><ActivityIndicator color="#fff" size="large" /></View>
      </View>
    );
  }

  // ----- Вход / регистрация -----
  if (!user) {
    const isUp = mode === 'signup';
    return (
      <View style={s.root}>
        <StatusBar style="light" />
        <Background T={T} />
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <Screen key={mode}>
            <ScrollView contentContainerStyle={s.loginBox} keyboardShouldPersistTaps="handled">
              <Text style={s.loginTitle}>{isUp ? 'Создать аккаунт' : 'С возвращением'}</Text>
              <TextInput
                style={s.loginInput}
                placeholder="Логин"
                placeholderTextColor={T.ph}
                autoCapitalize="none"
                autoCorrect={false}
                value={fLogin}
                onChangeText={setFLogin}
              />
              <TextInput
                style={[s.loginInput, { marginTop: 10 }]}
                placeholder="Пароль (минимум 6 символов)"
                placeholderTextColor={T.ph}
                secureTextEntry
                value={fPass}
                onChangeText={setFPass}
                onSubmitEditing={isUp ? signUp : signIn}
              />
              {isUp ? <Text style={s.loginHint}>По логину вас найдут друзья. Латиница, цифры, точка или _</Text> : null}
              {status ? <Text style={s.loginErr}>{status}</Text> : null}
              <Goo onPress={busy ? undefined : isUp ? signUp : signIn} style={s.loginBtn}>
                {busy ? <ActivityIndicator color={T.onAccent} /> : <Text style={s.loginBtnText}>{isUp ? 'Далее' : 'Войти'}</Text>}
              </Goo>
              <Pressable onPress={() => { setMode(isUp ? 'signin' : 'signup'); setStatus(''); }} style={{ marginTop: 16, alignItems: 'center' }}>
                <Text style={s.switchText}>{isUp ? 'Уже есть аккаунт? Войти' : 'Нет аккаунта? Зарегистрироваться'}</Text>
              </Pressable>
            </ScrollView>
          </Screen>
        </KeyboardAvoidingView>
      </View>
    );
  }

  // ----- Знакомство: имя и ник -----
  if (needSetup) {
    return (
      <View style={s.root}>
        <StatusBar style="light" />
        <Background T={T} />
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <Screen key="setup">
            <ScrollView contentContainerStyle={s.loginBox} keyboardShouldPersistTaps="handled">
              <Text style={s.loginTitle}>Давайте познакомимся</Text>
              <Text style={s.setupLabel}>Как вас зовут?</Text>
              <TextInput style={s.loginInput} placeholder="Имя" placeholderTextColor={T.ph} value={fName} onChangeText={setFName} />
              <Text style={[s.setupLabel, { marginTop: 18 }]}>Как вы хотите, чтобы видели ваше имя?</Text>
              <TextInput style={s.loginInput} placeholder={fName.trim() ? 'Никнейм, например ' + fName.trim() : 'Никнейм'} placeholderTextColor={T.ph} value={fNick} onChangeText={setFNick} />
              <Text style={s.loginHint}>Никнейм видят собеседники. Можно оставить пустым — тогда будет имя.</Text>
              {status ? <Text style={s.loginErr}>{status}</Text> : null}
              <Goo onPress={busy ? undefined : finishSetup} style={s.loginBtn}>
                {busy ? <ActivityIndicator color={T.onAccent} /> : <Text style={s.loginBtnText}>Готово</Text>}
              </Goo>
            </ScrollView>
          </Screen>
        </KeyboardAvoidingView>
      </View>
    );
  }

  // ----- Главная -----
  const renderHome = () => (
    <Screen key="home">
      <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 4 }} keyboardShouldPersistTaps="handled">
        <Text style={s.hello}>Привет, {shown(me) || '…'}</Text>
        <Text style={s.helloSub}>{chats.length ? 'Ваши переписки' : 'Начните первую переписку'}</Text>
        <View style={s.findRow}>
          <TextInput
            style={s.findInput}
            placeholder="Логин друга"
            placeholderTextColor={T.ph}
            autoCapitalize="none"
            autoCorrect={false}
            value={findLogin}
            onChangeText={setFindLogin}
            onSubmitEditing={startChat}
          />
          <Goo onPress={busy ? undefined : startChat} style={s.sendBtn} depth={0.82}>
            {busy ? <ActivityIndicator color={T.onAccent} /> : <Text style={s.sendText}>+</Text>}
          </Goo>
        </View>
        {chats.map((c) => {
          const o = otherOf(c);
          const fresh = unread(c);
          return (
            <Goo key={c.id} onPress={() => openChat(c)} style={s.card} depth={0.97}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <View style={{ marginRight: 12 }}><Avatar p={o} size={44} s={s} /></View>
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    <Text style={s.cardWhoTop} numberOfLines={1}>{o.nick}</Text>
                    <Text style={s.cardLabel}>{fmtTime(c.lastTs)}</Text>
                  </View>
                  <Text style={[s.cardText, fresh && { fontWeight: '700' }]} numberOfLines={1}>
                    {c.lastText ? (c.lastFrom === user.uid ? 'Вы: ' : '') + c.lastText : 'Пока нет сообщений'}
                  </Text>
                </View>
                {fresh ? <View style={s.dot} /> : null}
              </View>
            </Goo>
          );
        })}
      </ScrollView>
    </Screen>
  );

  // ----- Чат -----
  const renderChat = () => {
    if (!chat) {
      return (
        <Screen key="nochat">
          <View style={s.center}><Text style={s.placeholder}>Выберите переписку на Главной</Text></View>
        </Screen>
      );
    }
    const o = otherOf(chat);
    const theirRead = chat['r_' + o.uid] || 0;
    return (
      <View style={{ flex: 1 }}>
        <View style={s.chatHeader}>
          <Pressable onPress={() => go('Главная')} hitSlop={12} style={s.backBtn}>
            <Text style={s.backText}>‹</Text>
          </Pressable>
          <Avatar p={o} size={34} s={s} />
          <View style={{ marginLeft: 10, flex: 1 }}>
            <Text style={s.chatName} numberOfLines={1}>{o.nick}</Text>
            {o.login ? <Text style={s.chatSub} numberOfLines={1}>@{o.login}</Text> : null}
          </View>
        </View>
        {status ? <Text style={s.status}>{status}</Text> : null}
        <ScrollView
          ref={scrollRef}
          onContentSizeChange={() => scrollRef.current && scrollRef.current.scrollToEnd({ animated: true })}
          contentContainerStyle={{ paddingHorizontal: 12, paddingTop: 10, paddingBottom: 6 }}
          keyboardShouldPersistTaps="handled"
        >
          {messages.length === 0 ? <Text style={s.emptyChat}>Напишите первое сообщение</Text> : null}
          {messages.map((m) => (
            <Message
              key={m.id}
              m={m}
              mine={m.from === user.uid}
              seen={m.ts <= theirRead}
              open={picker === m.id}
              onOpen={() => !m.pending && setPicker(m.id)}
              onClose={() => setPicker(null)}
              onReact={react}
              onMedia={openMedia}
              loadingMedia={loadingMedia === m.id}
              s={s}
              T={T}
            />
          ))}
        </ScrollView>
        {sendingMedia ? <Text style={s.sendingNote}>{sendingMedia}</Text> : null}
        <View style={[s.inputWrap, kb && { marginBottom: 8 }]}>
          <Goo onPress={sendMedia} style={s.clipBtn} depth={0.82}>
            {sendingMedia ? <ActivityIndicator color={T.text} size="small" /> : <Text style={s.clipText}>📎</Text>}
          </Goo>
          <TextInput
            style={s.input}
            placeholder="Сообщение"
            placeholderTextColor={T.ph}
            value={text}
            onChangeText={setText}
            onSubmitEditing={send}
            multiline
          />
          <Goo onPress={send} style={s.sendBtnSm} depth={0.82}>
            <Text style={s.sendTextSm}>↑</Text>
          </Goo>
        </View>
      </View>
    );
  };

  // ----- Настройки -----
  const Seg = ({ value, label }) => (
    <Pressable onPress={() => setTheme(value)} style={[s.seg, themePref === value && s.segOn]}>
      <Text style={[s.segText, themePref === value && s.segTextOn]}>{label}</Text>
    </Pressable>
  );
  const renderSettings = () => (
    <Screen key="settings">
      <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 4 }}>
        <Goo onPress={openEdit} style={s.card} depth={0.97}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Avatar p={me} size={52} s={s} />
            <View style={{ marginLeft: 12, flex: 1 }}>
              <Text style={s.cardWhoTop}>{shown(me)}</Text>
              <Text style={s.cardLabel}>{user.login ? '@' + user.login : user.email}</Text>
            </View>
            <Text style={s.cardLabel}>Изменить ›</Text>
          </View>
        </Goo>

        <View style={s.card}>
          <Text style={s.sectionTitle}>Тема</Text>
          <View style={s.segRow}>
            <Seg value="light" label="Светлая" />
            <Seg value="dark" label="Тёмная" />
            <Seg value="system" label="Как в системе" />
          </View>
        </View>

        <View style={s.card}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <View style={{ flex: 1, paddingRight: 10 }}>
              <Text style={s.sectionTitle}>Уведомления</Text>
              <Text style={s.cardLabel}>
                {projectId() ? 'О новых сообщениях, когда приложение закрыто' : 'Заработают после подключения Expo в сборке'}
              </Text>
            </View>
            <Switch value={pushOn} onValueChange={setPush} />
          </View>
        </View>

        <Goo onPress={logout} style={s.bigBtn} depth={0.94}>
          <Text style={s.bigBtnText}>Выйти</Text>
        </Goo>
      </ScrollView>
    </Screen>
  );

  const totalUnread = chats.filter(unread).length;

  return (
    <View style={s.root}>
      <StatusBar style={inChat && !T.dark ? 'dark' : 'light'} />
      <Background T={T} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        {!inChat ? (
          <View style={s.top}>
            <Text style={s.topTitle}>{tab}</Text>
            <Pressable onPress={openEdit} hitSlop={8}>
              <Avatar p={me} size={38} s={s} />
            </Pressable>
          </View>
        ) : null}

        {!inChat && status ? <Text style={s.status}>{status}</Text> : null}

        <View style={{ flex: 1 }}>
          {tab === 'Главная' ? renderHome() : tab === 'Чат' ? renderChat() : renderSettings()}
        </View>

        {!kb && !inChat ? (
          <View style={s.tabBarWrap}>
            <View style={s.tabBar}>
              <Animated.View style={[s.indicator, { width: TAB_W, transform: [{ translateX: ix }, { scaleX: stretch }] }]} />
              {TABS.map((t) => (
                <Goo key={t} onPress={() => go(t)} style={[s.tabItem, { width: TAB_W }]} depth={0.9}>
                  <Text style={[s.tabText, tab === t && s.tabTextActive]}>{t}</Text>
                  {t === 'Главная' && totalUnread > 0 && tab !== 'Главная' ? <View style={s.tabDot} /> : null}
                </Goo>
              ))}
            </View>
          </View>
        ) : null}
      </KeyboardAvoidingView>

      {/* Просмотр фото и видео */}
      <Modal visible={!!viewer} transparent statusBarTranslucent navigationBarTranslucent animationType="fade" onRequestClose={() => setViewer(null)}>
        <Pressable style={s.viewer} onPress={() => setViewer(null)}>
          {viewer && viewer.img ? (
            <Image source={{ uri: 'data:image/jpeg;base64,' + viewer.img }} style={{ width: W, height: H * 0.85 }} resizeMode="contain" />
          ) : null}
          {viewer && viewer.video ? <VideoPlayer uri={viewer.video} /> : null}
          <Text style={s.viewerClose}>Нажмите, чтобы закрыть</Text>
        </Pressable>
      </Modal>

      {/* Редактирование профиля */}
      <Modal visible={editOpen} transparent statusBarTranslucent navigationBarTranslucent animationType="slide" onRequestClose={() => setEditOpen(false)}>
        <View style={s.sheetBack}>
          <ScrollView contentContainerStyle={s.sheet} keyboardShouldPersistTaps="handled">
            <Text style={s.sheetTitle}>Профиль</Text>
            <View style={{ alignItems: 'center', marginBottom: 14 }}>
              <Pressable onPress={pickAvatar}>
                <Avatar p={{ ...edit, nick: edit.nick || edit.name }} size={96} s={s} />
              </Pressable>
              <View style={{ flexDirection: 'row', marginTop: 10 }}>
                <Pressable onPress={pickAvatar} style={s.smallBtn}><Text style={s.smallBtnText}>Выбрать фото</Text></Pressable>
                {edit.avatar ? (
                  <Pressable onPress={() => setEdit((e) => ({ ...e, avatar: '' }))} style={[s.smallBtn, { marginLeft: 8 }]}>
                    <Text style={s.smallBtnText}>Убрать фото</Text>
                  </Pressable>
                ) : null}
              </View>
            </View>
            <Text style={s.cardLabel}>Цвет аватара</Text>
            <View style={s.colorRow}>
              {AV_COLORS.map((c) => (
                <Pressable key={c} onPress={() => setEdit((e) => ({ ...e, color: c }))} style={[s.colorDot, { backgroundColor: c }, edit.color === c && s.colorDotOn]} />
              ))}
            </View>
            <Text style={[s.cardLabel, { marginTop: 14 }]}>Имя</Text>
            <TextInput style={s.sheetInput} value={edit.name} onChangeText={(v) => setEdit((e) => ({ ...e, name: v }))} placeholder="Имя" placeholderTextColor={T.ph} />
            <Text style={[s.cardLabel, { marginTop: 12 }]}>Никнейм — так вас видят собеседники</Text>
            <TextInput style={s.sheetInput} value={edit.nick} onChangeText={(v) => setEdit((e) => ({ ...e, nick: v }))} placeholder="Никнейм" placeholderTextColor={T.ph} />
            <Text style={[s.cardLabel, { marginTop: 12 }]}>Логин: {user.login ? '@' + user.login : user.email}</Text>
            {status ? <Text style={[s.cardLabel, { color: '#d9534f', marginTop: 8 }]}>{status}</Text> : null}
            <View style={{ flexDirection: 'row', marginTop: 18 }}>
              <Pressable onPress={() => setEditOpen(false)} style={[s.sheetBtn, { backgroundColor: T.soft, marginRight: 10 }]}>
                <Text style={[s.sheetBtnText, { color: T.text }]}>Отмена</Text>
              </Pressable>
              <Pressable onPress={busy ? undefined : saveEdit} style={[s.sheetBtn, { backgroundColor: T.accent }]}>
                {busy ? <ActivityIndicator color={T.onAccent} /> : <Text style={[s.sheetBtnText, { color: T.onAccent }]}>Сохранить</Text>}
              </Pressable>
            </View>
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

function makeStyles(T, ins = { top: 0, bottom: 0 }) {
  const TOP = Math.max(ins.top, 24);
  const BOT = Math.max(ins.bottom, 0);
  const lift = { shadowColor: '#0b1a2b', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.22, shadowRadius: 12, elevation: 6 };
  const edge = { borderWidth: 1, borderColor: T.edge, borderBottomColor: T.edgeLow };
  return StyleSheet.create({
    root: { flex: 1 },
    top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: TOP + 8, paddingHorizontal: 18, paddingBottom: 4 },
    topTitle: { color: '#fff', fontSize: 24, fontWeight: '800', textShadowColor: 'rgba(0,0,0,0.25)', textShadowOffset: { width: 0, height: 2 }, textShadowRadius: 6 },
    avatarBase: { alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.35)' },
    status: { color: '#fff', textAlign: 'center', fontSize: 12, paddingHorizontal: 16, paddingTop: 4 },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    placeholder: { color: '#fff', fontSize: 15 },

    hello: { color: '#fff', fontSize: 28, fontWeight: '800', textShadowColor: 'rgba(0,0,0,0.25)', textShadowOffset: { width: 0, height: 2 }, textShadowRadius: 6 },
    helloSub: { color: 'rgba(255,255,255,0.9)', fontSize: 14, marginTop: 2, marginBottom: 14 },
    card: { backgroundColor: T.card, borderRadius: 22, padding: 14, marginBottom: 10, ...lift, ...edge },
    cardLabel: { fontSize: 12, color: T.sub, fontWeight: '600' },
    cardWhoTop: { fontSize: 15, color: T.text, fontWeight: '800', flexShrink: 1 },
    cardText: { fontSize: 14, color: T.text, marginTop: 2, opacity: 0.85 },
    dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: '#2f6fd6', marginLeft: 10 },
    sectionTitle: { fontSize: 15, color: T.text, fontWeight: '800', marginBottom: 4 },
    bigBtn: { backgroundColor: T.accent, borderRadius: 24, height: 50, alignItems: 'center', justifyContent: 'center', marginTop: 6, ...lift },
    bigBtnText: { color: T.onAccent, fontSize: 16, fontWeight: '700' },

    segRow: { flexDirection: 'row', backgroundColor: T.soft, borderRadius: 16, padding: 3, marginTop: 6 },
    seg: { flex: 1, height: 36, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
    segOn: { backgroundColor: T.accent },
    segText: { fontSize: 13, color: T.text, fontWeight: '600' },
    segTextOn: { color: T.onAccent },

    findRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: T.card, borderRadius: 26, paddingLeft: 16, paddingRight: 5, height: 50, marginBottom: 14, ...lift, ...edge },
    findInput: { flex: 1, fontSize: 15, color: T.text },

    chatHeader: { flexDirection: 'row', alignItems: 'center', paddingTop: TOP + 4, paddingBottom: 8, paddingHorizontal: 10, backgroundColor: T.header, borderBottomWidth: 1, borderBottomColor: T.edgeLow },
    backBtn: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center', marginRight: 4 },
    backText: { fontSize: 32, color: T.text, marginTop: -4 },
    chatName: { fontSize: 15, fontWeight: '800', color: T.text },
    chatSub: { fontSize: 11, color: T.sub },
    emptyChat: { color: 'rgba(255,255,255,0.9)', textAlign: 'center', marginTop: 40, fontSize: 15 },
    bubble: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 18, ...lift, shadowOffset: { width: 0, height: 3 }, shadowRadius: 6, elevation: 3, ...edge },
    mine: { backgroundColor: T.mine },
    theirs: { backgroundColor: T.theirs },
    bubbleText: { fontSize: 15, color: T.text },
    meta: { fontSize: 10, color: T.sub, alignSelf: 'flex-end', marginTop: 2 },
    media: { borderRadius: 15, backgroundColor: 'rgba(0,0,0,0.12)' },
    videoTile: { backgroundColor: '#1b1d24', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
    playBtn: { width: 48, height: 48, borderRadius: 24, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center' },
    playText: { color: '#fff', fontSize: 20, marginLeft: 3 },
    durText: { position: 'absolute', left: 8, bottom: 6, color: '#fff', fontSize: 11, fontWeight: '700', backgroundColor: 'rgba(0,0,0,0.45)', paddingHorizontal: 6, paddingVertical: 1, borderRadius: 8, overflow: 'hidden' },
    badge: { position: 'absolute', bottom: -12, backgroundColor: '#fff', borderRadius: 14, paddingHorizontal: 6, paddingVertical: 2, ...lift, elevation: 7 },
    picker: { flexDirection: 'row', backgroundColor: T.card, borderRadius: 26, padding: 4, marginBottom: 8, alignSelf: 'flex-start', ...lift, ...edge },
    pickBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
    pickEmoji: { fontSize: 24 },

    sendingNote: { color: '#fff', fontSize: 12, textAlign: 'center', paddingBottom: 4 },
    inputWrap: { flexDirection: 'row', alignItems: 'flex-end', backgroundColor: T.card, borderRadius: 22, marginHorizontal: 10, marginBottom: BOT + 8, paddingHorizontal: 4, paddingVertical: 4, minHeight: 44, ...lift, ...edge },
    input: { flex: 1, fontSize: 15, color: T.text, marginHorizontal: 6, paddingVertical: 8, maxHeight: 110 },
    clipBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: T.soft },
    clipText: { fontSize: 17 },
    sendBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: T.accent, alignItems: 'center', justifyContent: 'center' },
    sendText: { color: T.onAccent, fontSize: 20, fontWeight: '700' },
    sendBtnSm: { width: 36, height: 36, borderRadius: 18, backgroundColor: T.accent, alignItems: 'center', justifyContent: 'center' },
    sendTextSm: { color: T.onAccent, fontSize: 18, fontWeight: '700' },

    tabBarWrap: { alignItems: 'center', paddingBottom: BOT + 8, paddingTop: 4 },
    tabBar: { flexDirection: 'row', backgroundColor: T.tabBar, borderRadius: 26, padding: 4, ...lift, ...edge },
    indicator: { position: 'absolute', left: 4, top: 4, height: 38, borderRadius: 20, backgroundColor: T.accent },
    tabItem: { height: 38, alignItems: 'center', justifyContent: 'center' },
    tabText: { fontSize: 13, color: T.tabText, fontWeight: '700' },
    tabTextActive: { color: T.onAccent },
    tabDot: { position: 'absolute', top: 7, right: 12, width: 8, height: 8, borderRadius: 4, backgroundColor: '#2f6fd6' },

    viewer: { flex: 1, backgroundColor: 'rgba(0,0,0,0.94)', alignItems: 'center', justifyContent: 'center' },
    viewerClose: { color: 'rgba(255,255,255,0.6)', fontSize: 12, position: 'absolute', bottom: 40 },

    sheetBack: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end', paddingTop: TOP + 8 },
    sheet: { backgroundColor: T.dark ? '#22242d' : '#fbf6ea', borderTopLeftRadius: 26, borderTopRightRadius: 26, padding: 20, paddingBottom: BOT + 24 },
    sheetTitle: { fontSize: 20, fontWeight: '800', color: T.text, marginBottom: 14 },
    sheetInput: { backgroundColor: T.soft, borderRadius: 14, height: 44, paddingHorizontal: 14, fontSize: 15, color: T.text, marginTop: 6 },
    sheetBtn: { flex: 1, height: 46, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
    sheetBtnText: { fontSize: 15, fontWeight: '700' },
    smallBtn: { backgroundColor: T.soft, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 7 },
    smallBtnText: { color: T.text, fontSize: 13, fontWeight: '600' },
    colorRow: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 8 },
    colorDot: { width: 32, height: 32, borderRadius: 16, marginRight: 10, marginBottom: 8 },
    colorDotOn: { borderWidth: 3, borderColor: T.dark ? '#fff' : '#1c1c1e' },

    loginBox: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 26, paddingVertical: 40 },
    loginTitle: { color: '#fff', fontSize: 28, fontWeight: '800', marginBottom: 16, textShadowColor: 'rgba(0,0,0,0.25)', textShadowOffset: { width: 0, height: 2 }, textShadowRadius: 6 },
    setupLabel: { color: '#fff', fontSize: 15, fontWeight: '700', marginBottom: 8 },
    loginInput: { backgroundColor: T.card, borderRadius: 24, height: 50, paddingHorizontal: 18, fontSize: 16, color: T.text, ...lift, ...edge },
    loginHint: { color: 'rgba(255,255,255,0.85)', fontSize: 12, marginTop: 8 },
    loginErr: { color: '#fff', marginTop: 10, fontSize: 13, fontWeight: '700' },
    loginBtn: { backgroundColor: T.accent, borderRadius: 24, height: 50, alignItems: 'center', justifyContent: 'center', marginTop: 14, ...lift },
    loginBtnText: { color: T.onAccent, fontSize: 16, fontWeight: '700' },
    switchText: { color: '#fff', fontSize: 14, fontWeight: '600', textDecorationLine: 'underline' },
  });
}
