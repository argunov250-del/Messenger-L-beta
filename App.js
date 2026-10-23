import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TextInput, ScrollView, KeyboardAvoidingView, Platform,
  StyleSheet, Animated, Easing, Keyboard, Dimensions, Pressable, Image,
  BackHandler, ActivityIndicator,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as ImagePicker from 'expo-image-picker';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';

// ---------- Firebase ----------
const API_KEY = 'AIzaSyA4SPK_DVivGqseSwzCSFxBTCytb3AU68k';
const PROJECT = 'messenger-a8377';
const ROOT = 'projects/' + PROJECT + '/databases/(default)/documents';
const FS = 'https://firestore.googleapis.com/v1/' + ROOT;
const AUTH = 'https://identitytoolkit.googleapis.com/v1/accounts:';
const SESSION_KEY = 'messenger.session.v1';

// Значения Firestore <-> JS
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

const AUTH_ERR = {
  EMAIL_EXISTS: 'Эта почта уже зарегистрирована. Нажмите «Уже есть аккаунт».',
  EMAIL_NOT_FOUND: 'Аккаунт с такой почтой не найден.',
  INVALID_PASSWORD: 'Неверный пароль.',
  INVALID_LOGIN_CREDENTIALS: 'Неверная почта или пароль.',
  INVALID_EMAIL: 'Почта написана с ошибкой.',
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

// ---------- Анимации ----------
// Густая, тягучая кривая: медленно входит, медленно оседает
const VISC = Easing.bezier(0.22, 0.9, 0.3, 1);

const stops = [[65, 113, 154], [109, 126, 122], [232, 192, 112]];
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const colorAt = (t) => {
  const [a, b, k] = t < 0.5 ? [stops[0], stops[1], t * 2] : [stops[1], stops[2], (t - 0.5) * 2];
  return 'rgb(' + mix(a, b, k).join(',') + ')';
};

const TABS = ['Главная', 'Чат', 'Профиль'];
const EMOJIS = ['❤️', '👍', '😂', '🔥', '😮'];
const W = Dimensions.get('window').width;
const BAR_W = W - 32;
const TAB_W = Math.min(112, Math.floor((W - 56) / 3));

// ---------- Кнопка-жидкость ----------
// Медленное нажатие: палец вязнет, как в воде.
// Быстрый удар: жидкость твердеет, жёсткий толчок без раскачки.
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

// ---------- Плавающие капли фона ----------
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

function Background() {
  return (
    <View style={StyleSheet.absoluteFill}>
      {Array.from({ length: 48 }).map((_, i) => (
        <View key={i} style={{ flex: 1, backgroundColor: colorAt(i / 47) }} />
      ))}
      <Blob size={260} color="rgba(255,255,255,0.18)" x={-60} y={120} dx={90} dy={60} dur={9000} />
      <Blob size={220} color="rgba(255,214,120,0.22)" x={W - 150} y={380} dx={-80} dy={90} dur={11000} />
      <Blob size={300} color="rgba(40,80,140,0.20)" x={-80} y={560} dx={70} dy={-80} dur={13000} />
    </View>
  );
}

// ---------- Плавное появление экрана ----------
function Screen({ children }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(v, { toValue: 1, duration: 750, easing: VISC, useNativeDriver: true }).start();
  }, []);
  return (
    <Animated.View
      style={{ flex: 1, opacity: v, transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [26, 0] }) }] }}
    >
      {children}
    </Animated.View>
  );
}

// ---------- Сообщение ----------
function Message({ m, mine, seen, open, onOpen, onClose, onReact }) {
  const enter = useRef(new Animated.Value(0)).current;
  const shake = useRef(new Animated.Value(0)).current;
  const pop = useRef(new Animated.Value(m.reaction ? 1 : 0)).current;
  const prev = useRef(m.reaction);

  useEffect(() => {
    Animated.timing(enter, { toValue: 1, duration: 900, easing: VISC, useNativeDriver: true }).start();
  }, []);

  useEffect(() => {
    if (m.reaction && m.reaction !== prev.current) {
      // Удар по жидкости: она на миг становится твёрдой
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

  return (
    <Animated.View
      style={{
        alignSelf: mine ? 'flex-end' : 'flex-start',
        maxWidth: '80%',
        marginBottom: 16,
        opacity: enter,
        transform: [
          { translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [28, 0] }) },
          { scale: enter.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] }) },
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
      <Goo onPress={open ? onClose : undefined} onLongPress={onOpen} style={[s.bubble, mine ? s.mine : s.theirs, m.img ? { padding: 6 } : null]} depth={0.95}>
        {m.img ? (
          <Image source={{ uri: 'data:image/jpeg;base64,' + m.img }} style={[s.photo, m.w && m.h ? { aspectRatio: m.w / m.h } : null]} resizeMode="cover" />
        ) : null}
        {m.text ? <Text style={[s.bubbleText, m.img ? { paddingHorizontal: 7, paddingTop: 6 } : null]}>{m.text}</Text> : null}
        <Text style={[s.meta, m.img ? { paddingHorizontal: 7, paddingBottom: 3 } : null]}>
          {fmtTime(m.ts)}{mine ? (m.pending ? '  ·' : seen ? '  ✓✓' : '  ✓') : ''}
        </Text>
      </Goo>
      {m.reaction ? (
        <Animated.View style={[s.badge, mine ? { left: -10 } : { right: -10 }, { transform: [{ scale: pop }] }]}>
          <Text style={{ fontSize: 16 }}>{m.reaction}</Text>
        </Animated.View>
      ) : null}
    </Animated.View>
  );
}

// ---------- Приложение ----------
export default function App() {
  const [booting, setBooting] = useState(true);
  const [user, setUser] = useState(null); // { uid, email, name, idToken, refreshToken, exp }
  const userRef = useRef(null);

  // форма входа
  const [mode, setMode] = useState('signup');
  const [fName, setFName] = useState('');
  const [fEmail, setFEmail] = useState('');
  const [fPass, setFPass] = useState('');
  const [busy, setBusy] = useState(false);

  const [tab, setTab] = useState('Главная');
  const [status, setStatus] = useState('');
  const [chats, setChats] = useState([]);
  const [chat, setChat] = useState(null); // открытый чат
  const [messages, setMessages] = useState([]);
  const [findEmail, setFindEmail] = useState('');
  const [text, setText] = useState('');
  const [picker, setPicker] = useState(null);
  const [kb, setKb] = useState(false);
  const [sendingPhoto, setSendingPhoto] = useState(false);
  const scrollRef = useRef(null);
  const chatRef = useRef(null);

  const ix = useRef(new Animated.Value(0)).current;
  const stretch = useRef(new Animated.Value(1)).current;
  const squeeze = useRef(new Animated.Value(1)).current;
  const fly = useRef(new Animated.Value(0)).current;
  const [flying, setFlying] = useState('');

  useEffect(() => { userRef.current = user; }, [user]);
  useEffect(() => { chatRef.current = chat; }, [chat]);

  useEffect(() => {
    const a = Keyboard.addListener('keyboardDidShow', () => setKb(true));
    const b = Keyboard.addListener('keyboardDidHide', () => setKb(false));
    return () => { a.remove(); b.remove(); };
  }, []);

  // Кнопка «назад» на Android: из чата — на Главную
  useEffect(() => {
    const h = BackHandler.addEventListener('hardwareBackPress', () => {
      if (userRef.current && tab !== 'Главная') { go('Главная'); return true; }
      return false;
    });
    return () => h.remove();
  }, [tab]);

  // ----- Сессия -----
  const saveSession = async (u) => {
    setUser(u);
    userRef.current = u;
    if (u) await AsyncStorage.setItem(SESSION_KEY, JSON.stringify(u));
    else await AsyncStorage.removeItem(SESSION_KEY);
  };

  useEffect(() => {
    (async () => {
      try {
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

  // Запрос к Firestore от имени пользователя
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

  const signUp = async () => {
    const name = fName.trim();
    const email = fEmail.trim().toLowerCase();
    if (!name) { setStatus('Напишите имя'); return; }
    setBusy(true); setStatus('');
    try {
      const d = await authCall('signUp', { email, password: fPass });
      const u = { uid: d.localId, email, name, idToken: d.idToken, refreshToken: d.refreshToken, exp: Date.now() + Number(d.expiresIn) * 1000 - 60000 };
      await saveSession(u);
      await db(FS + '/users/' + u.uid, { method: 'PATCH', body: JSON.stringify({ fields: fields({ name, email, ts: Date.now() }) }) });
    } catch (e) {
      setStatus(e.message);
    }
    setBusy(false);
  };

  const signIn = async () => {
    const email = fEmail.trim().toLowerCase();
    setBusy(true); setStatus('');
    try {
      const d = await authCall('signInWithPassword', { email, password: fPass });
      let u = { uid: d.localId, email, name: d.displayName || '', idToken: d.idToken, refreshToken: d.refreshToken, exp: Date.now() + Number(d.expiresIn) * 1000 - 60000 };
      await saveSession(u);
      try {
        const p = unpack(await db(FS + '/users/' + u.uid));
        u = { ...u, name: p.name || email.split('@')[0] };
      } catch (e) {
        u = { ...u, name: email.split('@')[0] };
        await db(FS + '/users/' + u.uid, { method: 'PATCH', body: JSON.stringify({ fields: fields({ name: u.name, email, ts: Date.now() }) }) });
      }
      await saveSession(u);
    } catch (e) {
      setStatus(e.message);
    }
    setBusy(false);
  };

  const logout = async () => {
    setChats([]); setChat(null); setMessages([]); setTab('Главная'); ix.setValue(0);
    await saveSession(null);
  };

  // ----- Навигация -----
  const go = (t) => {
    const i = TABS.indexOf(t);
    setTab(t);
    setPicker(null);
    Animated.parallel([
      Animated.timing(ix, { toValue: i * TAB_W, duration: 800, easing: VISC, useNativeDriver: true }),
      Animated.sequence([
        Animated.timing(stretch, { toValue: 1.35, duration: 260, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.timing(stretch, { toValue: 1, duration: 600, easing: VISC, useNativeDriver: true }),
      ]),
    ]).start();
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
      setStatus('');
    } catch (e) {
      setStatus('Нет связи: ' + e.message);
    }
  };

  useEffect(() => {
    if (!user) return;
    loadChats();
    const t = setInterval(loadChats, 4000);
    return () => clearInterval(t);
  }, [user && user.uid]);

  const otherOf = (c) => {
    const u = userRef.current;
    const id = (c.members || []).find((m) => m !== u.uid) || u.uid;
    return { uid: id, name: c['n_' + id] || 'Друг' };
  };
  const unread = (c) => {
    const u = userRef.current;
    return c.lastTs && c.lastFrom && c.lastFrom !== u.uid && c.lastTs > (c['r_' + u.uid] || 0);
  };

  // ----- Новый чат по почте -----
  const startChat = async () => {
    const email = findEmail.trim().toLowerCase();
    const u = userRef.current;
    if (!email) return;
    if (email === u.email) { setStatus('Это ваша почта. Введите почту друга.'); return; }
    setBusy(true); setStatus('');
    try {
      const rows = await db(FS + ':runQuery', {
        method: 'POST',
        body: JSON.stringify({
          structuredQuery: {
            from: [{ collectionId: 'users' }],
            where: { fieldFilter: { field: { fieldPath: 'email' }, op: 'EQUAL', value: { stringValue: email } } },
            limit: 1,
          },
        }),
      });
      const found = (rows || []).find((r) => r.document);
      if (!found) { setStatus('Пользователь с такой почтой ещё не зарегистрирован.'); setBusy(false); return; }
      const friend = unpack(found.document);
      const id = chatIdOf(u.uid, friend.id);
      let c;
      try {
        c = unpack(await db(FS + '/chats/' + id));
      } catch (e) {
        if (e.code !== 404 && e.code !== 403) throw e;
        const data = { members: [u.uid, friend.id], lastTs: 0, lastText: '', lastFrom: '' };
        data['n_' + u.uid] = u.name;
        data['n_' + friend.id] = friend.name || email;
        c = unpack(await db(FS + '/chats/' + id + '?currentDocument.exists=false', { method: 'PATCH', body: JSON.stringify({ fields: fields(data) }) }));
      }
      setFindEmail('');
      openChat(c);
      loadChats();
    } catch (e) {
      setStatus('Не получилось: ' + e.message);
    }
    setBusy(false);
  };

  const openChat = (c) => {
    setMessages([]);
    setChat(c);
    chatRef.current = c;
    go('Чат');
  };

  // ----- Сообщения открытого чата -----
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
      // отметка «прочитано»
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

  // Отправка: поле резко сужается (удар), потом густо расправляется,
  // а из него вытягивается капля и поднимается к чату
  const launch = (msg) => {
    setFlying(msg);
    fly.setValue(0);
    squeeze.setValue(1);
    Animated.parallel([
      Animated.sequence([
        Animated.timing(squeeze, { toValue: 0.78, duration: 70, easing: Easing.linear, useNativeDriver: true }),
        Animated.timing(squeeze, { toValue: 1, duration: 1000, easing: VISC, useNativeDriver: true }),
      ]),
      Animated.timing(fly, { toValue: 1, duration: 1000, easing: Easing.bezier(0.3, 0, 0.2, 1), useNativeDriver: true }),
    ]).start((r) => { if (r.finished) setFlying(''); });
  };

  const postMessage = async (data, preview) => {
    const c = chatRef.current;
    const u = userRef.current;
    const ts = Date.now();
    const cid = u.uid + '-' + ts;
    const msg = { ...data, from: u.uid, ts, cid };
    setMessages((prev) => prev.concat([{ ...msg, id: cid, pending: true }]));
    await db(FS + '/chats/' + c.id + '/messages', { method: 'POST', body: JSON.stringify({ fields: fields(msg) }) });
    const f = { lastText: preview, lastTs: ts, lastFrom: u.uid };
    f['r_' + u.uid] = ts;
    await db(FS + '/chats/' + c.id + '?' + mask(Object.keys(f)), { method: 'PATCH', body: JSON.stringify({ fields: fields(f) }) });
    loadMessages();
  };

  const send = async () => {
    const t = text.trim();
    if (!t || !chatRef.current) return;
    setText('');
    launch(t);
    try {
      await postMessage({ text: t }, t);
    } catch (e) {
      setStatus('Не отправилось: ' + e.message);
    }
  };

  const sendPhoto = async () => {
    if (!chatRef.current || sendingPhoto) return;
    try {
      const pick = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 });
      if (pick.canceled || !pick.assets || !pick.assets.length) return;
      setSendingPhoto(true);
      const a = pick.assets[0];
      const big = (a.width || 0) >= (a.height || 0) ? { width: 900 } : { height: 900 };
      const r = await manipulateAsync(a.uri, [{ resize: big }], { compress: 0.5, format: SaveFormat.JPEG, base64: true });
      if (!r.base64) throw new Error('не удалось сжать фото');
      if (r.base64.length > 900000) throw new Error('фото слишком большое');
      launch('📷 Фото');
      await postMessage({ img: r.base64, w: r.width, h: r.height, text: '' }, '📷 Фото');
    } catch (e) {
      setStatus('Фото не отправилось: ' + e.message);
    }
    setSendingPhoto(false);
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

  // ----- Загрузка -----
  if (booting) {
    return (
      <View style={s.root}>
        <Background />
        <View style={s.center}><ActivityIndicator color="#fff" size="large" /></View>
      </View>
    );
  }

  // ----- Вход / регистрация -----
  if (!user) {
    const isUp = mode === 'signup';
    return (
      <View style={s.root}>
        <Background />
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <Screen key={mode}>
            <ScrollView contentContainerStyle={s.loginBox} keyboardShouldPersistTaps="handled">
              <Text style={s.loginTitle}>{isUp ? 'Создать аккаунт' : 'С возвращением'}</Text>
              {isUp ? (
                <TextInput style={s.loginInput} placeholder="Ваше имя" placeholderTextColor="#8a8470" value={fName} onChangeText={setFName} />
              ) : null}
              <TextInput
                style={[s.loginInput, { marginTop: isUp ? 12 : 0 }]}
                placeholder="Почта"
                placeholderTextColor="#8a8470"
                autoCapitalize="none"
                keyboardType="email-address"
                value={fEmail}
                onChangeText={setFEmail}
              />
              <TextInput
                style={[s.loginInput, { marginTop: 12 }]}
                placeholder="Пароль (минимум 6 символов)"
                placeholderTextColor="#8a8470"
                secureTextEntry
                value={fPass}
                onChangeText={setFPass}
              />
              {status ? <Text style={s.loginErr}>{status}</Text> : null}
              <Goo onPress={busy ? undefined : isUp ? signUp : signIn} style={s.loginBtn}>
                {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.loginBtnText}>{isUp ? 'Зарегистрироваться' : 'Войти'}</Text>}
              </Goo>
              <Pressable onPress={() => { setMode(isUp ? 'signin' : 'signup'); setStatus(''); }} style={{ marginTop: 18, alignItems: 'center' }}>
                <Text style={s.switchText}>{isUp ? 'Уже есть аккаунт? Войти' : 'Нет аккаунта? Зарегистрироваться'}</Text>
              </Pressable>
            </ScrollView>
          </Screen>
        </KeyboardAvoidingView>
      </View>
    );
  }

  // ----- Главная: список чатов -----
  const renderHome = () => (
    <Screen key="home">
      <ScrollView contentContainerStyle={{ padding: 20, paddingTop: 8 }} keyboardShouldPersistTaps="handled">
        <Text style={s.hello}>Привет, {user.name}</Text>
        <Text style={s.helloSub}>{chats.length ? 'Ваши переписки' : 'Начните первую переписку'}</Text>

        <View style={s.findRow}>
          <TextInput
            style={s.findInput}
            placeholder="Почта друга"
            placeholderTextColor="#8a8470"
            autoCapitalize="none"
            keyboardType="email-address"
            value={findEmail}
            onChangeText={setFindEmail}
            onSubmitEditing={startChat}
          />
          <Goo onPress={busy ? undefined : startChat} style={s.sendBtn} depth={0.82}>
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.sendText}>+</Text>}
          </Goo>
        </View>

        {chats.map((c) => {
          const o = otherOf(c);
          const fresh = unread(c);
          return (
            <Goo key={c.id} onPress={() => openChat(c)} style={s.card} depth={0.96}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <View style={[s.avatar, { width: 44, height: 44, borderRadius: 22, marginRight: 12 }]}>
                  <Text style={s.avatarText}>{(o.name || '?').charAt(0).toUpperCase()}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    <Text style={s.cardWhoTop}>{o.name}</Text>
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
          <View style={s.center}>
            <Text style={s.placeholder}>Выберите переписку на Главной</Text>
          </View>
        </Screen>
      );
    }
    const o = otherOf(chat);
    const theirRead = chat['r_' + o.uid] || 0;
    return (
      <Screen key={'chat-' + chat.id}>
        <Text style={s.chatWith}>{o.name}</Text>
        <ScrollView
          ref={scrollRef}
          onContentSizeChange={() => scrollRef.current && scrollRef.current.scrollToEnd({ animated: true })}
          contentContainerStyle={{ padding: 18, paddingTop: 10 }}
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
            />
          ))}
        </ScrollView>
      </Screen>
    );
  };

  // ----- Профиль -----
  const renderProfile = () => (
    <Screen key="profile">
      <View style={{ padding: 20 }}>
        <View style={s.card}>
          <Text style={s.cardLabel}>Имя</Text>
          <Text style={s.cardText}>{user.name}</Text>
          <Text style={[s.cardLabel, { marginTop: 14 }]}>Почта</Text>
          <Text style={s.cardText}>{user.email}</Text>
          <Text style={[s.cardLabel, { marginTop: 14 }]}>Друг находит вас по этой почте</Text>
        </View>
        <Goo onPress={logout} style={s.bigBtn} depth={0.93}>
          <Text style={s.bigBtnText}>Выйти</Text>
        </Goo>
      </View>
    </Screen>
  );

  const totalUnread = chats.filter(unread).length;

  return (
    <View style={s.root}>
      <Background />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <View style={s.top}>
          <Text style={s.topTitle}>{tab}</Text>
          <View style={s.avatar}>
            <Text style={s.avatarText}>{(user.name || '?').charAt(0).toUpperCase()}</Text>
          </View>
        </View>

        {status ? <Text style={s.status}>{status}</Text> : null}

        <View style={{ flex: 1 }}>
          {tab === 'Главная' ? renderHome() : tab === 'Чат' ? renderChat() : renderProfile()}
        </View>

        {tab === 'Чат' && chat ? (
          <View style={s.inputOuter}>
            <Animated.View
              pointerEvents="none"
              style={[s.neck, {
                opacity: fly.interpolate({ inputRange: [0, 0.03, 0.55, 0.62, 1], outputRange: [0, 1, 1, 0, 0] }),
                transform: [
                  { translateY: fly.interpolate({ inputRange: [0, 0.35, 0.6, 1], outputRange: [33, 0, 33, 33] }) },
                  { scaleX: fly.interpolate({ inputRange: [0, 0.35, 0.6, 1], outputRange: [1, 0.5, 0.2, 0.2] }) },
                  { scaleY: fly.interpolate({ inputRange: [0, 0.35, 0.6, 1], outputRange: [0.05, 1, 0.05, 0.05] }) },
                ],
              }]}
            />
            <Animated.View
              style={[s.inputWrap, {
                transform: [
                  { translateX: squeeze.interpolate({ inputRange: [0.78, 1], outputRange: [BAR_W * 0.11, 0] }) },
                  { scaleX: squeeze },
                ],
              }]}
            >
              <Goo onPress={sendPhoto} style={s.clipBtn} depth={0.82}>
                {sendingPhoto ? <ActivityIndicator color="#1c1c1e" /> : <Text style={s.clipText}>📷</Text>}
              </Goo>
              <TextInput
                style={s.input}
                placeholder="Сообщение"
                placeholderTextColor="#8a8470"
                value={text}
                onChangeText={setText}
                onSubmitEditing={send}
              />
              <Goo onPress={send} style={s.sendBtn} depth={0.82}>
                <Text style={s.sendText}>↑</Text>
              </Goo>
            </Animated.View>
            {flying ? (
              <Animated.View
                pointerEvents="none"
                style={[s.drop, {
                  opacity: fly.interpolate({ inputRange: [0, 0.06, 0.75, 1], outputRange: [0, 1, 1, 0] }),
                  transform: [
                    { translateY: fly.interpolate({ inputRange: [0, 1], outputRange: [0, -64] }) },
                    { scaleX: fly.interpolate({ inputRange: [0, 0.35, 1], outputRange: [0.45, 0.85, 1] }) },
                    { scaleY: fly.interpolate({ inputRange: [0, 0.35, 1], outputRange: [0.5, 1.25, 1] }) },
                  ],
                }]}
              >
                <Text style={s.bubbleText} numberOfLines={2}>{flying}</Text>
              </Animated.View>
            ) : null}
          </View>
        ) : null}

        {!kb ? (
          <View style={s.tabBarWrap}>
            <View style={s.tabBar}>
              <Animated.View
                style={[s.indicator, { width: TAB_W, transform: [{ translateX: ix }, { scaleX: stretch }] }]}
              />
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
    </View>
  );
}

const lift = {
  shadowColor: '#0b1a2b',
  shadowOffset: { width: 0, height: 10 },
  shadowOpacity: 0.28,
  shadowRadius: 16,
  elevation: 9,
};
const edge = {
  borderWidth: 1,
  borderColor: 'rgba(255,255,255,0.75)',
  borderBottomColor: 'rgba(0,0,0,0.14)',
};

const s = StyleSheet.create({
  root: { flex: 1 },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 56, paddingHorizontal: 22, paddingBottom: 6 },
  topTitle: { color: '#fff', fontSize: 28, fontWeight: '800', textShadowColor: 'rgba(0,0,0,0.25)', textShadowOffset: { width: 0, height: 2 }, textShadowRadius: 6 },
  avatar: { width: 48, height: 48, borderRadius: 24, backgroundColor: '#25272b', alignItems: 'center', justifyContent: 'center', ...lift, ...edge, borderColor: 'rgba(255,255,255,0.35)' },
  avatarText: { color: '#fff', fontSize: 20, fontWeight: '700' },
  status: { color: '#fff', textAlign: 'center', fontSize: 13, paddingHorizontal: 20, paddingTop: 4 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  placeholder: { color: '#fff', fontSize: 16 },

  hello: { color: '#fff', fontSize: 34, fontWeight: '800', textShadowColor: 'rgba(0,0,0,0.25)', textShadowOffset: { width: 0, height: 3 }, textShadowRadius: 8 },
  helloSub: { color: 'rgba(255,255,255,0.9)', fontSize: 16, marginTop: 4, marginBottom: 18 },
  card: { backgroundColor: 'rgba(255,248,230,0.92)', borderRadius: 28, padding: 16, marginBottom: 14, ...lift, ...edge },
  cardLabel: { fontSize: 13, color: '#7b7466', fontWeight: '600' },
  cardWhoTop: { fontSize: 16, color: '#1c1c1e', fontWeight: '800' },
  cardText: { fontSize: 16, color: '#222', marginTop: 3 },
  dot: { width: 12, height: 12, borderRadius: 6, backgroundColor: '#2f6fd6', marginLeft: 10 },
  bigBtn: { backgroundColor: '#1c1c1e', borderRadius: 32, height: 64, alignItems: 'center', justifyContent: 'center', marginTop: 6, ...lift, borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)' },
  bigBtnText: { color: '#fff', fontSize: 18, fontWeight: '700' },

  findRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,248,230,0.94)', borderRadius: 32, paddingLeft: 20, paddingRight: 7, height: 62, marginBottom: 18, ...lift, ...edge },
  findInput: { flex: 1, fontSize: 17, color: '#222' },

  chatWith: { color: '#fff', fontSize: 17, fontWeight: '700', paddingHorizontal: 22, paddingBottom: 2 },
  emptyChat: { color: 'rgba(255,255,255,0.9)', textAlign: 'center', marginTop: 40, fontSize: 16 },
  bubble: { padding: 13, paddingBottom: 8, borderRadius: 24, ...lift, shadowOffset: { width: 0, height: 6 }, shadowRadius: 10, elevation: 6, ...edge },
  mine: { backgroundColor: 'rgba(255,248,230,0.96)' },
  theirs: { backgroundColor: 'rgba(255,255,255,0.7)' },
  bubbleText: { fontSize: 16, color: '#222' },
  meta: { fontSize: 11, color: '#7b7466', alignSelf: 'flex-end', marginTop: 3 },
  photo: { width: W * 0.62, aspectRatio: 1, borderRadius: 19, backgroundColor: 'rgba(0,0,0,0.08)' },
  badge: { position: 'absolute', bottom: -14, backgroundColor: '#fff', borderRadius: 16, paddingHorizontal: 7, paddingVertical: 3, ...lift, shadowOffset: { width: 0, height: 4 }, shadowRadius: 6, elevation: 8 },
  picker: { flexDirection: 'row', backgroundColor: 'rgba(255,255,255,0.92)', borderRadius: 30, padding: 6, marginBottom: 10, alignSelf: 'flex-start', ...lift, ...edge },
  pickBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  pickEmoji: { fontSize: 26 },

  inputOuter: { marginHorizontal: 16, marginBottom: 12 },
  neck: { position: 'absolute', right: 24, bottom: 56, width: 14, height: 70, borderRadius: 7, backgroundColor: 'rgba(255,248,230,0.94)' },
  drop: { position: 'absolute', right: 8, bottom: 56, maxWidth: '70%', backgroundColor: 'rgba(255,248,230,0.97)', borderRadius: 24, paddingVertical: 13, paddingHorizontal: 16, shadowColor: '#0b1a2b', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.25, shadowRadius: 10, elevation: 12 },
  inputWrap: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,248,230,0.94)', borderRadius: 32, paddingLeft: 7, paddingRight: 7, height: 62, ...lift, ...edge },
  input: { flex: 1, fontSize: 17, color: '#222', marginLeft: 8 },
  clipBtn: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.06)' },
  clipText: { fontSize: 22 },
  sendBtn: { width: 48, height: 48, borderRadius: 24, backgroundColor: '#1c1c1e', alignItems: 'center', justifyContent: 'center', ...lift, shadowOffset: { width: 0, height: 5 }, shadowRadius: 8, elevation: 6 },
  sendText: { color: '#fff', fontSize: 22, fontWeight: '700' },

  tabBarWrap: { alignItems: 'center', paddingBottom: 26, paddingTop: 4 },
  tabBar: { flexDirection: 'row', backgroundColor: 'rgba(255,255,255,0.4)', borderRadius: 38, padding: 6, ...lift, ...edge },
  indicator: { position: 'absolute', left: 6, top: 6, height: 52, borderRadius: 32, backgroundColor: '#1c1c1e', shadowColor: '#000', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.35, shadowRadius: 8, elevation: 6 },
  tabItem: { height: 52, alignItems: 'center', justifyContent: 'center' },
  tabText: { fontSize: 15, color: '#42525e', fontWeight: '700' },
  tabTextActive: { color: '#fff' },
  tabDot: { position: 'absolute', top: 10, right: 14, width: 9, height: 9, borderRadius: 5, backgroundColor: '#2f6fd6' },

  loginBox: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 28, paddingVertical: 40 },
  loginTitle: { color: '#fff', fontSize: 32, fontWeight: '800', marginBottom: 18, textShadowColor: 'rgba(0,0,0,0.25)', textShadowOffset: { width: 0, height: 3 }, textShadowRadius: 8 },
  loginInput: { backgroundColor: 'rgba(255,248,230,0.94)', borderRadius: 30, height: 58, paddingHorizontal: 22, fontSize: 17, color: '#222', ...lift, ...edge },
  loginErr: { color: '#fff', marginTop: 12, fontSize: 14, fontWeight: '600' },
  loginBtn: { backgroundColor: '#1c1c1e', borderRadius: 30, height: 58, alignItems: 'center', justifyContent: 'center', marginTop: 14, ...lift },
  loginBtnText: { color: '#fff', fontSize: 17, fontWeight: '700' },
  switchText: { color: '#fff', fontSize: 15, fontWeight: '600', textDecorationLine: 'underline' },
});
