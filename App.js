import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  View, Text, TextInput, ScrollView, KeyboardAvoidingView, Platform,
  StyleSheet, Animated, Easing, Keyboard, Dimensions, Pressable, Image, PanResponder,
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
  if (key.startsWith('WEAK_PASSWORD')) return tr('Пароль слишком короткий: нужно минимум 6 символов.');
  return AUTH_ERR[key] ? tr(AUTH_ERR[key]) : m;
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
const MONTHS_RU = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const dayKind = (ts) => {
  const d = new Date(ts);
  const now = new Date();
  const y = new Date(now.getTime() - 86400000);
  if (d.toDateString() === now.toDateString()) return 'today';
  if (d.toDateString() === y.toDateString()) return 'yesterday';
  return '';
};
const dayLabel = (ts) => {
  const k = dayKind(ts);
  if (k === 'today') return RU ? 'Сегодня' : 'Today';
  if (k === 'yesterday') return RU ? 'Вчера' : 'Yesterday';
  const d = new Date(ts);
  const yr = d.getFullYear() !== new Date().getFullYear() ? ' ' + d.getFullYear() : '';
  return RU ? d.getDate() + ' ' + MONTHS_RU[d.getMonth()] + yr : MONTHS_EN[d.getMonth()] + ' ' + d.getDate() + yr;
};
const seenLabel = (ts) => {
  if (!ts) return '';
  if (Date.now() - ts < 70000) return tr('в сети');
  const d = new Date(ts);
  const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  const k = dayKind(ts);
  if (RU) return 'был(а) ' + (k === 'today' ? 'в ' + hm : k === 'yesterday' ? 'вчера в ' + hm : dayLabel(ts));
  return 'last seen ' + (k === 'today' ? 'at ' + hm : k === 'yesterday' ? 'yesterday at ' + hm : dayLabel(ts));
};
const fmtDur = (sec) => { const t = Math.max(1, Math.round(sec || 0)); return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); };
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
    await Notifications.setNotificationChannelAsync('messages', {
      name: tr('Сообщения'),
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 150, 250],
      sound: 'default',
      enableVibrate: true,
      showBadge: true,
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    });
    try { await Notifications.deleteNotificationChannelAsync('default'); } catch (e) {}
  }
  let { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted') status = (await Notifications.requestPermissionsAsync()).status;
  if (status !== 'granted') return '';
  const t = await Notifications.getExpoPushTokenAsync({ projectId: pid });
  return t.data || '';
}

async function pushTo(token, title, body, data) {
  if (!token) return null;
  try {
    const r = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ to: token, title, body, data, sound: 'default', channelId: 'messages', priority: 'high', ttl: 86400 }),
    });
    return await r.json();
  } catch (e) { return { error: String(e) }; }
}

async function pushReceipt(id) {
  try {
    const r = await fetch('https://exp.host/--/api/v2/push/getReceipts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ ids: [id] }),
    });
    const j = await r.json();
    return (j && j.data && j.data[id]) || null;
  } catch (e) { return null; }
}

// ---------- Язык: оригинал английский, русский по системе ----------
const SYS_LANG = (() => {
  let l = '';
  try { l = Intl.DateTimeFormat().resolvedOptions().locale || ''; } catch (e) {}
  try { if (typeof navigator !== 'undefined' && navigator.language) l = navigator.language; } catch (e) {}
  return String(l || 'en').toLowerCase();
})();
const RU = SYS_LANG.startsWith('ru');
const EN = {" МБ)": " MB)", " печатает…": " is typing…", " секунд": " seconds", " участн.": " members", "» не найден.": "” not found.", "Аккаунт не найден.": "Account not found.", "Аккаунт отключён.": "Account disabled.", "Введите логин": "Enter a username", "Введите название группы": "Enter a group name", "Видео не открылось: ": "Video failed to open: ", "Видео отправляется…": "Sending video…", "Вкл.": "On", "Возможности": "Features", "Войти": "Sign in", "Вы": "You", "Вы: ": "You: ", "Выкл.": "Off", "Голосовое": "Voice message", "Голосовое отправляется…": "Sending voice message…", "Голосовое — кнопка справа от поля": "Voice message — button right of the field", "Группа": "Group", "Группа создана": "Group created", "Группы — включаются в «Оформлении»": "Groups — turn on in Appearance", "Далее": "Next", "Данные и память": "Data and storage", "Двойное нажатие — реакция": "Double tap — react", "Добавьте хотя бы один логин": "Add at least one username", "Долгое нажатие — ответить, изменить, удалить": "Long press — reply, edit, delete", "Доставка: ": "Delivery: ", "Друг": "Friend", "Закат": "Sunset", "Запись пока работает только в веб-версии": "Recording works only in the web version for now", "Заработают после подключения Expo в сборке.": "Will work once Expo is connected in the build.", "Имя не может быть пустым": "Name can't be empty", "Как в системе": "System", "Конфиденциальность": "Privacy", "Кружочек": "Video message", "Кружочек отправляется…": "Sending video message…", "Кружочек — видео до 30 секунд": "Video message — up to 30 seconds", "Кто-то": "Someone", "Кэш медиа очищен": "Media cache cleared", "Лайм": "Lime", "Логин содержит недопустимые символы.": "Username contains invalid characters.", "Логин: 3–20 символов, латиница, цифры, точка или _": "Username: 3–20 characters, latin letters, digits, dot or _", "Медиа": "Media", "НЕТ": "NO", "Напишите, как вас зовут": "Tell us your name", "Не выполнен вход": "Not signed in", "Не изменилось: ": "Not edited: ", "Не найден: ": "Not found: ", "Не отправилось: ": "Not sent: ", "Не получилось: ": "Failed: ", "Не сохранилось: ": "Not saved: ", "Не удалилось: ": "Not deleted: ", "Неверный логин или пароль.": "Wrong username or password.", "Неверный пароль.": "Wrong password.", "Нет аккаунта? Зарегистрироваться": "No account? Sign up", "Нет доступа к камере": "No camera access", "Нет доступа к микрофону": "No microphone access", "Нет связи: ": "No connection: ", "Никнейм": "Nickname", "Никнейм, например ": "Nickname, e.g. ", "Новое сообщение": "New message", "О новых сообщениях, когда приложение закрыто.": "About new messages when the app is closed.", "Ответ: ": "Reply: ", "Оформление": "Appearance", "Ошибка токена: ": "Token error: ", "Ошибка: ": "Error: ", "Пароль слишком короткий: нужно минимум 6 символов.": "Password too short: at least 6 characters.", "Пока нет сообщений": "No messages yet", "Пользователь «": "User “", "Разрешение: ": "Permission: ", "Реакция не отправилась: ": "Reaction not sent: ", "Редактирование": "Editing", "С возвращением": "Welcome back", "Свайп сообщения влево — ответить": "Swipe a message left — reply", "Сверни приложение — через 5 с придёт тест": "Minimize the app — a test arrives in 5 s", "Светлая": "Light", "Синий": "Blue", "Слишком много попыток. Подождите немного.": "Too many attempts. Please wait a bit.", "Создать аккаунт": "Create account", "Сообщения": "Messages", "Тест": "Test", "Токен сохранён в профиле": "Token saved to profile", "Токен: ": "Token: ", "Тёмная": "Dark", "Уведомления": "Notifications", "Уведомления работают": "Notifications work", "Уже есть аккаунт? Войти": "Already have an account? Sign in", "Участник": "Member", "Фото не выбрано: ": "Photo not picked: ", "Фото отправляется…": "Sending photo…", "Это вы. Введите логин друга.": "That's you. Enter a friend's username.", "Этот логин уже занят. Придумайте другой.": "This username is taken. Pick another one.", "Язык": "Language", "в сети": "online", "видео больше 8 МБ (": "video over 8 MB (", "видео длиннее ": "video longer than ", "есть": "yes", "ещё нет квитанции": "no receipt yet", "изм. ": "edited ", "не удалось сжать фото": "couldn't compress photo", "печатает…": "typing…", "фото слишком большое": "photo too large", "⭕ Кружочек": "⭕ Video message", "🎤 Голосовое": "🎤 Voice message", "🎬 Видео": "🎬 Video", "📷 Фото": "📷 Photo", "Версия": "Version", "Выберите переписку на Главной": "Pick a chat on the main screen", "Выбрать фото": "Choose photo", "Готово": "Done", "Давайте познакомимся": "Let's get acquainted", "Имя": "Name", "Как вас зовут?": "What's your name?", "Как вы хотите, чтобы видели ваше имя?": "How should others see your name?", "Логин:": "Username:", "Нажмите, чтобы закрыть": "Tap to close", "Напишите первое сообщение": "Write the first message", "Никнейм видят собеседники. Можно оставить пустым — тогда будет имя.": "Others see your nickname. Leave empty to use your name.", "Никнейм — так вас видят собеседники": "Nickname — how others see you", "Новая группа": "New group", "Отмена": "Cancel", "По логину вас найдут друзья. Латиница, цифры, точка или _": "Friends find you by username. Latin letters, digits, dot or _", "Пока нет переписок. Нажмите «+», чтобы найти собеседника": "No chats yet. Tap “+” to find someone", "Показывать вкладку «Группы» в нижней панели.": "Show the Groups tab in the bottom bar.", "Профиль": "Profile", "Собеседники не увидят, когда вы были в сети.": "Others won't see when you were online.", "Создать": "Create", "Сохранить": "Save", "Убрать фото": "Remove photo", "Файлы остаются в переписке и загрузятся снова при открытии.": "Files stay in the chat and load again when opened.", "Цвет аватара": "Avatar color", "Цвет приложения": "App color", "‹ Настройки": "‹ Settings", "↩  Ответить": "↩  Reply", "✎  Изменить": "✎  Edit", "🗑  Удалить": "🗑  Delete", "Выйти": "Log out", "Голосовые и кружочки в кэше": "Voice and video messages in cache", "Изменить фотографию": "Change photo", "Кнопка «Группы»": "Groups button", "Логин": "Username", "Логины участников через запятую": "Member usernames, comma separated", "Мой профиль": "My profile", "Название": "Title", "Найти Кирилла": "Find someone", "Очистить кэш медиа": "Clear media cache", "Пароль (минимум 6 символов)": "Password (at least 6 characters)", "Проверить уведомления": "Test notifications", "Русский": "Русский", "Скрывать «в сети»": "Hide online status", "Сообщение": "Message", "Чаты": "Chats", "Группы": "Groups", "Настройки": "Settings"};
const tr = (ru) => (RU ? ru : (EN[ru] !== undefined ? EN[ru] : ru));

// ---------- Темы ----------
const THEMES = {
  light: {
    dark: false, bg: '#f4f8fd',
    card: '#ffffff', text: '#111216', sub: '#5c6370', ph: '#9aa0aa',
    mine: '#dbe6ff', theirs: '#ffffff',
    accent: '#2f6bff', onAccent: '#fff',
    tabBar: '#ffffff', tabText: '#3a3f48',
    soft: 'rgba(0,0,0,0.05)', edge: 'rgba(0,0,0,0.05)', edgeLow: 'rgba(0,0,0,0.10)',
    header: '#ffffff', glass: '#ffffff', glassEdge: 'rgba(0,0,0,0.06)', glassLine: 'rgba(0,0,0,0.07)',
  },
  dark: {
    dark: true, bg: '#000000',
    card: '#1c1c1f', text: '#f2f2f5', sub: '#9a9aa6', ph: '#6f6f7a',
    mine: '#1f4fd1', theirs: '#1f1f23',
    accent: '#2f6bff', onAccent: '#fff',
    tabBar: '#1c1c1f', tabText: '#b4b8c6',
    soft: 'rgba(255,255,255,0.07)', edge: 'rgba(255,255,255,0.09)', edgeLow: 'rgba(0,0,0,0.6)',
    header: '#121214', glass: '#1c1c1f', glassEdge: 'rgba(255,255,255,0.09)', glassLine: 'rgba(255,255,255,0.07)',
  },
};
// Фирменные цвета интерфейса (фон всегда статичный)
const BRANDS = {
  blue: { name: t(tr('Синий')), accent: '#2f6bff', onAccent: '#fff', grad: [[48, 48, 48], [36, 70, 170], [47, 107, 255]], mine: { light: '#dbe6ff', dark: '#1f4fd1' } },
  lime: { name: t(tr('Лайм')), accent: '#8fd629', onAccent: '#111', grad: [[48, 48, 48], [100, 150, 40], [166, 242, 58]], mine: { light: '#e6f8cc', dark: '#3d6b12' } },
  sunset: { name: t(tr('Закат')), accent: '#e0a040', onAccent: '#111', grad: [[48, 48, 48], [150, 110, 60], [232, 192, 112]], mine: { light: '#fbecd0', dark: '#7a5520' } },
};
const AV_COLORS = ['#25272b', '#3b6fd6', '#2e9d6a', '#d9534f', '#e08a2c', '#8e5bd6', '#d6457f', '#2aa3b8'];

const VISC = Easing.bezier(0.22, 0.9, 0.3, 1);
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const colorAt = (stops, t) => {
  const [a, b, k] = t < 0.5 ? [stops[0], stops[1], t * 2] : [stops[1], stops[2], (t - 0.5) * 2];
  return 'rgb(' + mix(a, b, k).join(',') + ')';
};

const APP_VERSION = '0.00.06.3';
const ALL_TABS = ['Чаты', 'Группы', 'Настройки'];
const TAB_ICON = { 'Чаты': '💬', 'Группы': '👥', 'Настройки': '⚙️' };
const EMOJIS = ['❤️', '👍', '😂', '🔥', '😮'];
const W = Dimensions.get('window').width;
const H = Dimensions.get('window').height;
const PLUS = 52; // диаметр кружков нижней панели
const GAP = 20;  // одинаковое расстояние между кружками
const ROW_W = Math.min(W - 32, 360);
const FIND_MS = 560;
// кружки вкладок + плюс, по центру и на равном расстоянии
const layoutRow = (tabs) => {
  const n = tabs.length + 1;
  const start = Math.round((ROW_W - (n * PLUS + (n - 1) * GAP)) / 2);
  const pos = {};
  tabs.forEach((t, i) => { pos[t] = start + i * (PLUS + GAP); });
  pos.plus = start + tabs.length * (PLUS + GAP);
  return pos;
};
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
  return <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: T.bg }]} />;
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

// ---------- Голосовые и кружочки (веб) ----------
const IS_WEB = Platform.OS === 'web';
const VOICE_MAX = 60;
const CIRCLE_MAX = 30;
const CIRCLE = 200;
const blobCache = {};
const b64ToUrl = (b64, mime) => {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([arr], { type: mime || 'application/octet-stream' }));
};
const blobToB64 = (blob) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(',')[1] || '');
  r.onerror = rej;
  r.readAsDataURL(blob);
});
const pickMime = (list) => {
  try { for (const m of list) if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m; } catch (e) {}
  return '';
};
const WebVideo = (props) => React.createElement('video', props);
const BARS = [0.35, 0.6, 0.9, 0.5, 0.75, 1, 0.55, 0.8, 0.4, 0.7, 0.95, 0.6, 0.45, 0.85, 0.5, 0.65, 0.3, 0.75, 0.55, 0.4];

function VoiceBody({ m, mine, getUrl, s, T }) {
  const [state, setState] = useState('idle'); // idle | load | play
  const [prog, setProg] = useState(0);
  const audio = useRef(null);
  useEffect(() => () => { try { audio.current && audio.current.pause(); } catch (e) {} }, []);
  const toggle = async () => {
    if (!IS_WEB) return;
    if (state === 'play') { audio.current.pause(); setState('idle'); return; }
    try {
      if (!audio.current) {
        setState('load');
        const url = await getUrl(m);
        const a = new Audio(url);
        a.ontimeupdate = () => setProg(a.duration && isFinite(a.duration) ? a.currentTime / a.duration : a.currentTime / (m.dur || 1));
        a.onended = () => { setState('idle'); setProg(0); };
        audio.current = a;
      }
      await audio.current.play();
      setState('play');
    } catch (e) { setState('idle'); }
  };
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 2, minWidth: 190 }}>
      <Pressable onPress={toggle} style={s.voiceBtn}>
        {state === 'load' ? <ActivityIndicator color={T.onAccent} size="small" /> : <Text style={s.voiceBtnText}>{state === 'play' ? '❚❚' : '▶'}</Text>}
      </Pressable>
      <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', height: 26, marginLeft: 8 }}>
        {BARS.map((h, i) => (
          <View key={i} style={{ width: 3, marginRight: 2, borderRadius: 2, height: 4 + h * 20, backgroundColor: i / BARS.length <= prog ? '#2f8cff' : T.sub, opacity: i / BARS.length <= prog ? 1 : 0.45 }} />
        ))}
      </View>
      <Text style={[s.meta, { marginLeft: 6, alignSelf: 'center' }]}>{fmtDur(m.dur)}</Text>
    </View>
  );
}

function CircleBody({ m, getUrl, s }) {
  const [url, setUrl] = useState(null);
  const [loading, setLoading] = useState(false);
  const open = async () => {
    if (!IS_WEB || url || loading) return;
    setLoading(true);
    try { setUrl(await getUrl(m)); } catch (e) {}
    setLoading(false);
  };
  return (
    <Pressable onPress={open} style={s.circle}>
      {url ? (
        <WebVideo src={url} autoPlay playsInline controls={false} onClick={(e) => { const v = e.target; if (v.paused) v.play(); else v.pause(); }}
          onEnded={(e) => { e.target.currentTime = 0; }}
          style={{ width: CIRCLE, height: CIRCLE, objectFit: 'cover', borderRadius: CIRCLE / 2, transform: 'scaleX(-1)' }} />
      ) : (
        <View style={s.playBtn}>{loading ? <ActivityIndicator color="#fff" /> : <Text style={s.playText}>▶</Text>}</View>
      )}
      {!url ? <Text style={[s.durText, { left: CIRCLE / 2 - 18, bottom: 14 }]}>{fmtDur(m.dur)}</Text> : null}
    </Pressable>
  );
}

// ---------- Видео-плеер ----------
function VideoPlayer({ uri }) {
  const player = useVideoPlayer(uri, (p) => { p.loop = false; p.play(); });
  return <VideoView player={player} style={{ width: W, height: H * 0.75 }} contentFit="contain" nativeControls />;
}

// ---------- Сообщение ----------
function Message({ m, mine, seen, open, onOpen, onClose, onReact, onMedia, onReply, onEdit, onDelete, onQuote, replyName, who, getUrl, loadingMedia, s, T }) {
  // свайп влево — ответить (как в Telegram)
  const drag = useRef(new Animated.Value(0)).current;
  const lastTap = useRef(0);
  const pan = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (e, g) => g.dx < -12 && Math.abs(g.dx) > Math.abs(g.dy) * 2,
    onPanResponderMove: (e, g) => drag.setValue(Math.max(-80, Math.min(0, g.dx))),
    onPanResponderRelease: (e, g) => {
      if (g.dx < -55) onReply && onReply(m);
      Animated.spring(drag, { toValue: 0, stiffness: 400, damping: 28, mass: 1, useNativeDriver: false }).start();
    },
    onPanResponderTerminate: () => Animated.spring(drag, { toValue: 0, stiffness: 400, damping: 28, mass: 1, useNativeDriver: false }).start(),
  })).current;
  const tap = () => {
    const now = Date.now();
    if (now - lastTap.current < 300 && !m.pending) { lastTap.current = 0; onReact(m, '❤️'); return; }
    lastTap.current = now;
  };
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
  const isCircle = !!m.circle;
  const size = isMedia ? mediaSize(m.w, m.h) : null;

  return (
    <Animated.View
      {...pan.panHandlers}
      style={{
        alignSelf: mine ? 'flex-end' : 'flex-start',
        maxWidth: '80%',
        marginBottom: m.reaction ? 16 : 8,
        opacity: enter,
        marginRight: drag.interpolate({ inputRange: [-80, 0], outputRange: [80, 0] }),
        marginLeft: drag,
        transform: [
          { translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) },
          { translateX: shake },
        ],
      }}
    >
      <Animated.Text style={[s.swipeIcon, mine ? { right: -34 } : { right: -34 }, { opacity: drag.interpolate({ inputRange: [-60, -20, 0], outputRange: [1, 0.3, 0] }) }]}>↩</Animated.Text>
      {open ? (
        <View style={{ alignSelf: mine ? 'flex-end' : 'flex-start' }}>
          <View style={s.picker}>
            {EMOJIS.map((e) => (
              <Goo key={e} onPress={() => onReact(m, e)} style={s.pickBtn} depth={0.85}>
                <Text style={s.pickEmoji}>{e}</Text>
              </Goo>
            ))}
          </View>
          <View style={s.menu}>
            <Pressable onPress={() => onReply(m)} style={s.menuItem}><Text style={s.menuText}>{tr('↩  Ответить')}</Text></Pressable>
            {mine && m.text && !m.img && !m.video ? (
              <Pressable onPress={() => onEdit(m)} style={s.menuItem}><Text style={s.menuText}>{tr('✎  Изменить')}</Text></Pressable>
            ) : null}
            {mine ? (
              <Pressable onPress={() => onDelete(m)} style={s.menuItem}><Text style={[s.menuText, { color: '#e5484d' }]}>{tr('🗑  Удалить')}</Text></Pressable>
            ) : null}
          </View>
        </View>
      ) : null}
      <Goo
        onPress={open ? onClose : isMedia && !m.pending ? () => onMedia(m) : tap}
        onLongPress={onOpen}
        style={isCircle ? { alignItems: mine ? 'flex-end' : 'flex-start' } : [s.bubble, mine ? s.mine : s.theirs, isMedia ? { padding: 4 } : null]}
        depth={0.96}
      >
        {who && !mine ? <Text style={[s.quoteWho, { marginBottom: 2 }]}>{who}</Text> : null}
        {m.voice ? <VoiceBody m={m} mine={mine} getUrl={getUrl} s={s} T={T} /> : null}
        {m.circle ? <CircleBody m={m} getUrl={getUrl} s={s} /> : null}
        {m.rText !== undefined && m.rId ? (
          <Pressable onPress={() => onQuote && onQuote(m.rId)} style={[s.quote, isMedia ? { margin: 4 } : null]}>
            <Text style={s.quoteWho} numberOfLines={1}>{replyName(m.rFrom)}</Text>
            <Text style={s.quoteText} numberOfLines={1}>{m.rText || t(tr('Медиа'))}</Text>
          </Pressable>
        ) : null}
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
        <Text style={[s.meta, isMedia ? { paddingHorizontal: 6, paddingBottom: 2 } : null, isCircle ? s.circleMeta : null]}>
          {m.edited ? tr('изм. ') : ''}{fmtTime(m.ts)}{mine ? (m.pending ? '  ·' : seen ? '  ✓✓' : '  ✓') : ''}
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
  const [groupsOn, setGroupsOn] = useState(false);
  const [hideSeen, setHideSeen] = useState(false);
  const [brand, setBrandState] = useState('blue');
  const [setPage, setSetPage] = useState(null);
  const [pushDiag, setPushDiag] = useState('');
  const baseT = THEMES[themePref === 'system' ? (sys === 'dark' ? 'dark' : 'light') : themePref];
  const br = BRANDS[brand] || BRANDS.blue;
  const T = { ...baseT, accent: br.accent, onAccent: br.onAccent, mine: br.mine[baseT.dark ? 'dark' : 'light'] };
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

  const [tab, setTab] = useState('Чаты');
  const [status, setStatus] = useState('');
  const [chats, setChats] = useState([]);
  const [profiles, setProfiles] = useState({});
  const profilesRef = useRef({});
  const [chat, setChat] = useState(null);
  const [messages, setMessages] = useState([]);
  const [findLogin, setFindLogin] = useState('');
  const [finding, setFinding] = useState(false);
  const fo = useRef(new Animated.Value(0)).current; // 0 — панель, 1 — поиск
  const goo = useRef(new Animated.Value(1)).current;
  const findRef = useRef(null);
  const openFind = () => {
    if (finding) return;
    setFinding(true);
    goo.setValue(1);
    Animated.parallel([
      Animated.timing(fo, { toValue: 1, duration: FIND_MS, easing: VISC, useNativeDriver: false }),
      Animated.sequence([
        Animated.timing(goo, { toValue: 1.16, duration: 140, easing: Easing.out(Easing.quad), useNativeDriver: false }),
        Animated.timing(goo, { toValue: 0.97, duration: 190, easing: Easing.inOut(Easing.quad), useNativeDriver: false }),
        Animated.timing(goo, { toValue: 1, duration: 230, easing: VISC, useNativeDriver: false }),
      ]),
    ]).start(() => { try { findRef.current && findRef.current.focus(); } catch (e) {} });
  };
  const closeFind = () => {
    try { findRef.current && findRef.current.blur(); } catch (e) {}
    goo.setValue(1);
    Animated.parallel([
      Animated.timing(fo, { toValue: 0, duration: FIND_MS, easing: VISC, useNativeDriver: false }),
      Animated.sequence([
        Animated.timing(goo, { toValue: 1.12, duration: 140, easing: Easing.out(Easing.quad), useNativeDriver: false }),
        Animated.timing(goo, { toValue: 0.98, duration: 190, easing: Easing.inOut(Easing.quad), useNativeDriver: false }),
        Animated.timing(goo, { toValue: 1, duration: 230, easing: VISC, useNativeDriver: false }),
      ]),
    ]).start(() => setFinding(false));
  };
  const [text, setText] = useState('');
  const [picker, setPicker] = useState(null);
  const [replyTo, setReplyTo] = useState(null);
  const [editing, setEditing] = useState(null);
  const typingSent = useRef(0);
  const inputRef = useRef(null);
  const [kb, setKb] = useState(false);
  const [sendingMedia, setSendingMedia] = useState('');
  const [viewer, setViewer] = useState(null); // { img } | { video: uri }
  const [loadingMedia, setLoadingMedia] = useState('');
  const [editOpen, setEditOpen] = useState(false);
  const [edit, setEdit] = useState({});
  const scrollRef = useRef(null);
  const chatRef = useRef(null);

  // жидкий индикатор: левый и правый край двигаются по очереди
  const TABS = groupsOn ? ALL_TABS : ALL_TABS.filter((t) => t !== 'Группы');
  const pos0 = layoutRow(['Чаты', 'Настройки']);
  const posRef = useRef(pos0);
  const ixL = useRef(new Animated.Value(pos0['Чаты'])).current;
  const ixR = useRef(new Animated.Value(pos0['Чаты'] + PLUS)).current;
  const squish = useRef(new Animated.Value(1)).current;
  const tabIdx = useRef(0);
  const xs = useRef(null);
  if (!xs.current) {
    xs.current = {};
    ['Чаты', 'Группы', 'Настройки', 'plus'].forEach((k) => {
      xs.current[k] = new Animated.Value(k === 'Группы' ? pos0['Настройки'] : pos0[k]);
    });
  }
  const vis = useRef({ 'Чаты': new Animated.Value(1), 'Группы': new Animated.Value(0), 'Настройки': new Animated.Value(1) }).current;
  const firstLay = useRef(true);
  // появление/скрытие кружка «Группы»: панель плавно перестраивается и остаётся по центру
  useEffect(() => {
    const pos = layoutRow(TABS);
    if (!groupsOn) pos['Группы'] = pos['Настройки'];
    posRef.current = pos;
    const cur = TABS.indexOf(tab) >= 0 ? tab : 'Чаты';
    tabIdx.current = TABS.indexOf(cur);
    const sp = (v, to) => Animated.spring(v, { toValue: to, stiffness: 260, damping: 22, mass: 1, useNativeDriver: false });
    if (firstLay.current) {
      firstLay.current = false;
      Object.keys(xs.current).forEach((k) => xs.current[k].setValue(pos[k]));
      vis['Группы'].setValue(groupsOn ? 1 : 0);
      ixL.setValue(pos[cur]); ixR.setValue(pos[cur] + PLUS);
      return;
    }
    Animated.parallel([
      ...Object.keys(xs.current).map((k) => sp(xs.current[k], pos[k])),
      sp(vis['Группы'], groupsOn ? 1 : 0),
      sp(ixL, pos[cur]),
      sp(ixR, pos[cur] + PLUS),
    ]).start();
  }, [groupsOn]);

  useEffect(() => { userRef.current = user; }, [user]);
  useEffect(() => { chatRef.current = chat; }, [chat]);

  useEffect(() => {
    const a = Keyboard.addListener('keyboardDidShow', () => setKb(true));
    const b = Keyboard.addListener('keyboardDidHide', () => setKb(false));
    return () => { a.remove(); b.remove(); };
  }, []);

  const inChat = tab === 'Чаты' && !!chat;

  useEffect(() => {
    const h = BackHandler.addEventListener('hardwareBackPress', () => {
      if (viewer) { setViewer(null); return true; }
      if (editOpen) { setEditOpen(false); return true; }
      if (finding) { closeFind(); return true; }
      if (setPage) { setSetPage(null); return true; }
      if (userRef.current && tab === 'Чаты' && chat) { closeChat(); return true; }
      if (userRef.current && tab !== 'Чаты') { go('Чаты'); return true; }
      return false;
    });
    return () => h.remove();
  }, [tab, viewer, editOpen, finding, chat, setPage]);

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
    try {
      const old = JSON.parse((await AsyncStorage.getItem(PREFS_KEY)) || '{}');
      await AsyncStorage.setItem(PREFS_KEY, JSON.stringify({ ...old, ...p }));
    } catch (e) {}
  };

  useEffect(() => {
    (async () => {
      try {
        const pr = await AsyncStorage.getItem(PREFS_KEY);
        if (pr) {
          const p = JSON.parse(pr);
          if (p.theme) setThemePref(p.theme);
          if (typeof p.push === 'boolean') setPushOn(p.push);
          if (typeof p.groups === 'boolean') setGroupsOn(p.groups);
          if (typeof p.hideSeen === 'boolean') setHideSeen(p.hideSeen);
          if (p.brand && BRANDS[p.brand]) setBrandState(p.brand);
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
    if (!u) throw new Error(tr('Не выполнен вход'));
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
    if (!LOGIN_RE.test(login)) { setStatus(tr('Логин: 3–20 символов, латиница, цифры, точка или _')); return; }
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
    if (!raw) { setStatus(tr('Введите логин')); return; }
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
    if (!name) { setStatus(tr('Напишите, как вас зовут')); return; }
    setBusy(true); setStatus('');
    try {
      const color = AV_COLORS[Math.floor(Math.random() * AV_COLORS.length)];
      const data = { name, nick, color };
      await patchUser(data);
      setMe((p) => ({ ...p, ...data }));
      setNeedSetup(false);
    } catch (e) {
      setStatus(tr('Не сохранилось: ') + e.message);
    }
    setBusy(false);
  };

  const logout = async () => {
    try { if (me && me.pushToken) await patchUser({ pushToken: '' }); } catch (e) {}
    setChats([]); setChat(null); setMessages([]); setTab('Чаты'); tabIdx.current = 0; ixL.setValue(posRef.current['Чаты']); ixR.setValue(posRef.current['Чаты'] + PLUS); setMe(null); setNeedSetup(false);
    setFLogin(''); setFPass(''); setFName(''); setFNick('');
    await saveSession(null);
  };

  // ----- Навигация -----
  const go = (t) => {
    const i = TABS.indexOf(t);
    const from = tabIdx.current;
    tabIdx.current = i;
    setTab(t);
    setPicker(null);
    if (i === from) return;
    const x = posRef.current[t];
    const right = i > from;
    // ведущий край тянется к новому кружку, затем хвост догоняет — капля перетекает
    const lead = Animated.timing(right ? ixR : ixL, { toValue: right ? x + PLUS : x, duration: 260, easing: Easing.out(Easing.cubic), useNativeDriver: false });
    const tail = Animated.timing(right ? ixL : ixR, { toValue: right ? x : x + PLUS, duration: 340, easing: VISC, useNativeDriver: false });
    Animated.parallel([
      lead,
      Animated.sequence([Animated.delay(140), tail]),
      Animated.sequence([
        Animated.timing(squish, { toValue: 0.78, duration: 200, easing: Easing.out(Easing.quad), useNativeDriver: false }),
        Animated.timing(squish, { toValue: 1.06, duration: 180, easing: Easing.inOut(Easing.quad), useNativeDriver: false }),
        Animated.timing(squish, { toValue: 1, duration: 160, easing: VISC, useNativeDriver: false }),
      ]),
    ]).start();
  };
  const closeChat = () => { setChat(null); chatRef.current = null; setMessages([]); setReplyTo(null); setEditing(null); setText(''); };

  // ----- «В сети» -----
  useEffect(() => {
    if (!user || needSetup) return;
    if (hideSeen) { patchUser({ seen: 0 }).catch(() => {}); return; }
    const beat = () => { if (AppState.currentState === 'active' || Platform.OS === 'web') patchUser({ seen: Date.now() }).catch(() => {}); };
    beat();
    const t = setInterval(beat, 30000);
    return () => clearInterval(t);
  }, [user && user.uid, needSetup, hideSeen]);

  // ----- «печатает…» -----
  const onType = (v) => {
    setText(v);
    const c = chatRef.current;
    const u = userRef.current;
    const now = Date.now();
    if (!c || !u || !v || now - typingSent.current < 3000) return;
    typingSent.current = now;
    db(FS + '/chats/' + c.id + '?' + mask(['t_' + u.uid]), { method: 'PATCH', body: JSON.stringify({ fields: fields({ ['t_' + u.uid]: now }) }) }).catch(() => {});
  };
  const isTyping = (c, uid) => !!(c && c['t_' + uid] && Date.now() - c['t_' + uid] < 6000 && !(c.lastFrom === uid && c.lastTs > c['t_' + uid]));

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
      setStatus(tr('Нет связи: ') + e.message);
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
    if (c && c.group) return { uid: '', group: true, name: c.title || t(tr('Группа')), nick: c.title || t(tr('Группа')), color: '#5b7cfa' };
    const id = (c.members || []).find((m) => m !== u.uid) || u.uid;
    const p = profiles[id] || {};
    return { ...p, uid: id, nick: shown(p) || c['n_' + id] || t(tr('Друг')) };
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
    if (q === u.login || q === u.email) { setStatus(tr('Это вы. Введите логин друга.')); return; }
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
      if (!found) { setStatus(tr('Пользователь «') + q + t(tr('» не найден.'))); setBusy(false); return; }
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
      fo.setValue(0); setFinding(false);
      openChat(c);
      loadChats();
    } catch (e) {
      setStatus(tr('Не получилось: ') + e.message);
    }
    setBusy(false);
  };

  const openChat = (c) => {
    if (!chatRef.current || chatRef.current.id !== c.id) setMessages([]);
    setChat(c);
    chatRef.current = c;
    go('Чаты');
  };

  // ----- Сообщения -----
  const loadMessages = async () => {
    const c = chatRef.current;
    const u = userRef.current;
    if (!c || !u) return;
    try {
      const [data, cd] = await Promise.all([
        db(FS + '/chats/' + c.id + '/messages?orderBy=ts%20desc&pageSize=60'),
        db(FS + '/chats/' + c.id).catch(() => null),
      ]);
      if (cd && chatRef.current && chatRef.current.id === c.id) {
        const fresh = { ...chatRef.current, ...unpack(cd) };
        chatRef.current = fresh;
        setChat(fresh);
      }
      loadProfiles((c.members || []).filter((x) => x !== u.uid));
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
      setStatus(tr('Нет связи: ') + e.message);
    }
  };

  useEffect(() => {
    if (!user || !chat || tab !== 'Чаты') return;
    loadMessages();
    const t = setInterval(loadMessages, 2500);
    return () => clearInterval(t);
  }, [user && user.uid, chat && chat.id, tab]);

  const notifyOther = async (c, preview) => {
    const u = userRef.current;
    const ids = (c.members || []).filter((x) => x !== u.uid);
    await loadProfiles(ids, true);
    ids.forEach((id) => {
      const p = profilesRef.current[id];
      if (!p || !p.pushToken) return;
      if (c.group) pushTo(p.pushToken, c.title || t(tr('Группа')), (shown(me) || t(tr('Кто-то'))) + ': ' + preview, { chatId: c.id });
      else pushTo(p.pushToken, shown(me) || t(tr('Новое сообщение')), preview, { chatId: c.id });
    });
  };
  const memberName = (c, uid) => shown(profiles[uid]) || (c && c['n_' + uid]) || t(tr('Участник'));
  const typingWho = (c) => {
    const u = userRef.current;
    if (!c || !u) return '';
    const id = (c.members || []).find((x) => x !== u.uid && isTyping(c, x));
    if (!id) return '';
    return c.group ? memberName(c, id) + tr(' печатает…') : t(tr('печатает…'));
  };
  const readByOthers = (c) => {
    const u = userRef.current;
    return Math.max(0, ...(c.members || []).filter((x) => x !== u.uid).map((x) => c['r_' + x] || 0));
  };

  // ----- Поиск пользователя и группы -----
  const findUser = async (raw) => {
    const q = raw.trim().toLowerCase().replace(/^@/, '');
    if (!q) return null;
    const field = q.includes('@') ? 'email' : 'login';
    const rows = await db(FS + ':runQuery', {
      method: 'POST',
      body: JSON.stringify({ structuredQuery: { from: [{ collectionId: 'users' }], where: { fieldFilter: { field: { fieldPath: field }, op: 'EQUAL', value: { stringValue: q } } }, limit: 1 } }),
    });
    const f = (rows || []).find((r) => r.document);
    return f ? unpack(f.document) : null;
  };
  const [gTitle, setGTitle] = useState('');
  const [gLogins, setGLogins] = useState('');
  const [gBusy, setGBusy] = useState(false);
  const [gMsg, setGMsg] = useState('');
  const createGroup = async () => {
    const u = userRef.current;
    const title = gTitle.trim();
    const logins = gLogins.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
    if (!title) { setGMsg(tr('Введите название группы')); return; }
    if (!logins.length) { setGMsg(tr('Добавьте хотя бы один логин')); return; }
    setGBusy(true); setGMsg('');
    try {
      const people = [];
      for (const l of logins) {
        const f = await findUser(l);
        if (!f) { setGMsg(tr('Не найден: ') + l); setGBusy(false); return; }
        if (f.id !== u.uid && !people.find((x) => x.id === f.id)) people.push(f);
      }
      const id = 'g_' + u.uid.slice(0, 6) + Date.now();
      const data = { group: true, title, owner: u.uid, members: [u.uid, ...people.map((x) => x.id)], lastTs: Date.now(), lastText: t(tr('Группа создана')), lastFrom: u.uid };
      data['n_' + u.uid] = shown(me) || u.login;
      people.forEach((x) => { data['n_' + x.id] = shown(x) || x.login; });
      data['r_' + u.uid] = data.lastTs;
      const c = unpack(await db(FS + '/chats/' + id + '?currentDocument.exists=false', { method: 'PATCH', body: JSON.stringify({ fields: fields(data) }) }));
      setGTitle(''); setGLogins('');
      openChat(c);
      loadChats();
    } catch (e) { setGMsg(tr('Не получилось: ') + e.message); }
    setGBusy(false);
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
    f['t_' + u.uid] = 0;
    typingSent.current = 0;
    await db(FS + '/chats/' + c.id + '?' + mask(Object.keys(f)), { method: 'PATCH', body: JSON.stringify({ fields: fields(f) }) });
    loadMessages();
    notifyOther(c, preview);
  };

  const replyFields = () => (replyTo ? { rId: replyTo.id, rText: replyTo.text || (replyTo.img ? tr('📷 Фото') : replyTo.video ? tr('🎬 Видео') : replyTo.voice ? tr('🎤 Голосовое') : replyTo.circle ? tr('⭕ Кружочек') : ''), rFrom: replyTo.from } : {});
  const send = async () => {
    const t = text.trim();
    if (!t || !chatRef.current) return;
    setText('');
    if (editing) {
      const m = editing;
      setEditing(null);
      if (t === m.text) return;
      setMessages((prev) => prev.map((x) => (x.id === m.id ? { ...x, text: t, edited: true } : x)));
      try {
        await db('https://firestore.googleapis.com/v1/' + m.path + '?' + mask(['text', 'edited']), { method: 'PATCH', body: JSON.stringify({ fields: fields({ text: t, edited: true }) }) });
        const c = chatRef.current;
        if (c && c.lastTs === m.ts) await db(FS + '/chats/' + c.id + '?' + mask(['lastText']), { method: 'PATCH', body: JSON.stringify({ fields: fields({ lastText: t }) }) });
      } catch (e) { setStatus(tr('Не изменилось: ') + e.message); }
      return;
    }
    const rf = replyFields();
    setReplyTo(null);
    try {
      await postMessage({ text: t, ...rf }, t);
    } catch (e) {
      setStatus(tr('Не отправилось: ') + e.message);
    }
  };
  const startReply = (m) => { setPicker(null); setEditing(null); setReplyTo(m); try { inputRef.current && inputRef.current.focus(); } catch (e) {} };
  const startEdit = (m) => { setPicker(null); setReplyTo(null); setEditing(m); setText(m.text || ''); try { inputRef.current && inputRef.current.focus(); } catch (e) {} };
  const removeMsg = async (m) => {
    setPicker(null);
    setMessages((prev) => prev.filter((x) => x.id !== m.id));
    try {
      await db('https://firestore.googleapis.com/v1/' + m.path, { method: 'DELETE' });
      const c = chatRef.current;
      if (c && c.lastTs === m.ts) {
        const rest = messages.filter((x) => x.id !== m.id && !x.pending);
        const last = rest[rest.length - 1];
        const f = last
          ? { lastText: last.text || (last.img ? tr('📷 Фото') : t(tr('🎬 Видео'))), lastTs: last.ts, lastFrom: last.from }
          : { lastText: '', lastTs: 0, lastFrom: '' };
        await db(FS + '/chats/' + c.id + '?' + mask(Object.keys(f)), { method: 'PATCH', body: JSON.stringify({ fields: fields(f) }) });
      }
    } catch (e) { setStatus(tr('Не удалилось: ') + e.message); }
  };
  const msgY = useRef({});
  const jumpTo = (id) => { const y = msgY.current[id]; if (y !== undefined && scrollRef.current) scrollRef.current.scrollTo({ y: Math.max(0, y - 80), animated: true }); };
  const nameOf = (uid) => {
    if (uid === (user && user.uid)) return t(tr('Вы'));
    const c = chatRef.current || chat || { members: [] };
    return c.group ? memberName(c, uid) : otherOf(c).nick;
  };

  // ----- Голосовые и кружочки -----
  const recRef = useRef(null);
  const [rec, setRec] = useState(null); // { kind, sec, stream }
  const getUrl = async (m) => {
    const key = m.voice || m.circle;
    if (blobCache[key]) return blobCache[key];
    const c = chatRef.current;
    const parts = await Promise.all(Array.from({ length: m.parts || 1 }).map((_, i) =>
      db(FS + '/chats/' + c.id + '/media/' + key + '_' + i).then((d) => unpack(d).d || '')));
    blobCache[key] = b64ToUrl(parts.join(''), m.mime);
    return blobCache[key];
  };
  const startRec = async (kind) => {
    if (rec || !chatRef.current) return;
    if (!IS_WEB || !navigator.mediaDevices || !window.MediaRecorder) { setStatus(tr('Запись пока работает только в веб-версии')); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia(kind === 'voice'
        ? { audio: true }
        : { audio: true, video: { facingMode: 'user', width: { ideal: 320 }, height: { ideal: 320 } } });
      const mime = kind === 'voice'
        ? pickMime(['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'])
        : pickMime(['video/webm;codecs=vp8,opus', 'video/mp4', 'video/webm']);
      const opts = kind === 'voice' ? { audioBitsPerSecond: 32000 } : { videoBitsPerSecond: 280000, audioBitsPerSecond: 32000 };
      if (mime) opts.mimeType = mime;
      const mr = new MediaRecorder(stream, opts);
      const chunks = [];
      mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      const start = Date.now();
      const timer = setInterval(() => {
        const sec = (Date.now() - start) / 1000;
        setRec((r) => (r ? { ...r, sec } : r));
        if (sec >= (kind === 'voice' ? VOICE_MAX : CIRCLE_MAX)) stopRec(true);
      }, 200);
      recRef.current = { mr, stream, chunks, kind, start, timer, mime: mime || mr.mimeType };
      mr.start(250);
      setRec({ kind, sec: 0, stream });
    } catch (e) {
      setStatus(kind === 'voice' ? tr('Нет доступа к микрофону') : t(tr('Нет доступа к камере')));
    }
  };
  const stopRec = (send) => {
    const r = recRef.current;
    if (!r) return;
    recRef.current = null;
    clearInterval(r.timer);
    setRec(null);
    r.mr.onstop = async () => {
      r.stream.getTracks().forEach((t) => t.stop());
      const dur = (Date.now() - r.start) / 1000;
      if (!send || dur < 0.7) return;
      try {
        setSendingMedia(r.kind === 'voice' ? tr('Голосовое отправляется…') : t(tr('Кружочек отправляется…')));
        const blob = new Blob(r.chunks, { type: r.mime || (r.kind === 'voice' ? 'audio/webm' : 'video/webm') });
        const b64 = await blobToB64(blob);
        const c = chatRef.current;
        const u = userRef.current;
        const mid = (r.kind === 'voice' ? 'v' : 'c') + u.uid.slice(0, 8) + Date.now();
        const parts = Math.ceil(b64.length / CHUNK);
        for (let i = 0; i < parts; i++) {
          await db(FS + '/chats/' + c.id + '/media/' + mid + '_' + i, { method: 'PATCH', body: JSON.stringify({ fields: { d: { stringValue: b64.slice(i * CHUNK, (i + 1) * CHUNK) } } }) });
        }
        blobCache[mid] = URL.createObjectURL(blob);
        const rf = replyFields();
        setReplyTo(null);
        const data = { [r.kind]: mid, parts, dur: Math.max(1, Math.round(dur)), mime: blob.type, text: '', ...rf };
        await postMessage(data, r.kind === 'voice' ? tr('🎤 Голосовое') : t(tr('⭕ Кружочек')));
      } catch (e) { setStatus(tr('Не отправилось: ') + e.message); }
      setSendingMedia('');
    };
    try { r.mr.stop(); } catch (e) {}
  };

  const sendPhotoAsset = async (a) => {
    const big = (a.width || 0) >= (a.height || 0) ? { width: 1000 } : { height: 1000 };
    const r = await manipulateAsync(a.uri, [{ resize: big }], { compress: 0.5, format: SaveFormat.JPEG, base64: true });
    if (!r.base64) throw new Error(tr('не удалось сжать фото'));
    if (r.base64.length > 900000) throw new Error(tr('фото слишком большое'));
    await postMessage({ img: r.base64, w: r.width, h: r.height, text: '' }, t(tr('📷 Фото')));
  };

  const sendVideoAsset = async (a) => {
    const dur = (a.duration || 0) / 1000;
    if (dur > VIDEO_MAX_SEC + 0.5) throw new Error(tr('видео длиннее ') + VIDEO_MAX_SEC + t(tr(' секунд')));
    let size = a.fileSize || 0;
    if (!size) {
      const info = await FileSystem.getInfoAsync(a.uri);
      size = info.size || 0;
    }
    if (size > VIDEO_MAX_BYTES) throw new Error(tr('видео больше 8 МБ (') + (size / 1048576).toFixed(1) + t(tr(' МБ)')));
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
    await postMessage({ video: mid, parts, dur: Math.round(dur || 1), w: a.width || 0, h: a.height || 0, text: '' }, t(tr('🎬 Видео')));
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
        setSendingMedia(tr('Видео отправляется…'));
        await sendVideoAsset(a);
      } else {
        setSendingMedia(tr('Фото отправляется…'));
        await sendPhotoAsset(a);
      }
    } catch (e) {
      setStatus(tr('Не отправилось: ') + e.message);
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
      setStatus(tr('Видео не открылось: ') + e.message);
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
      setStatus(tr('Реакция не отправилась: ') + e.message);
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
      setStatus(tr('Фото не выбрано: ') + e.message);
    }
  };
  const saveEdit = async () => {
    const name = (edit.name || '').trim();
    if (!name) { setStatus(tr('Имя не может быть пустым')); return; }
    const data = { name, nick: (edit.nick || '').trim() || name, color: edit.color, avatar: edit.avatar || '' };
    setBusy(true);
    try {
      await patchUser(data);
      setMe((p) => ({ ...p, ...data }));
      setEditOpen(false);
      setStatus('');
    } catch (e) {
      setStatus(tr('Не сохранилось: ') + e.message);
    }
    setBusy(false);
  };

  const setTheme = (v) => { setThemePref(v); savePrefs({ theme: v, push: pushOn, groups: groupsOn }); };
  const testPush = async () => {
    const lines = [];
    const say = () => setPushDiag(lines.join('\n'));
    try {
      lines.push('Project ID: ' + (projectId() ? tr('есть') : t(tr('НЕТ')))); say();
      const perm = await Notifications.getPermissionsAsync();
      lines.push(tr('Разрешение: ') + perm.status); say();
      let t = '';
      try { t = await getPushToken(); } catch (e) { lines.push(tr('Ошибка токена: ') + (e && e.message ? e.message : String(e))); say(); return; }
      lines.push(tr('Токен: ') + (t ? t.slice(0, 30) + '…' : t(tr('НЕТ')))); say();
      if (!t) return;
      if (t !== (me && me.pushToken)) { await patchUser({ pushToken: t }); setMe((p) => ({ ...p, pushToken: t })); lines.push(tr('Токен сохранён в профиле')); say(); }
      lines.push(tr('Сверни приложение — через 5 с придёт тест')); say();
      await new Promise((r) => setTimeout(r, 5000));
      const res = await pushTo(t, t(tr('Тест')), t(tr('Уведомления работают')), {});
      const d = res && res.data;
      const one = Array.isArray(d) ? d[0] : d;
      lines.push('Expo: ' + (one ? one.status + (one.message ? ' — ' + one.message : '') : JSON.stringify(res))); say();
      if (one && one.id) {
        await new Promise((r) => setTimeout(r, 6000));
        const rc = await pushReceipt(one.id);
        lines.push(tr('Доставка: ') + (rc ? rc.status + (rc.message ? ' — ' + rc.message : '') + (rc.details && rc.details.error ? ' (' + rc.details.error + ')' : '') : t(tr('ещё нет квитанции')))); say();
      }
    } catch (e) { lines.push(tr('Ошибка: ') + (e && e.message ? e.message : String(e))); say(); }
  };
  const setPush = (v) => { setPushOn(v); savePrefs({ theme: themePref, push: v, groups: groupsOn }); };
  const setGroups = (v) => { setGroupsOn(v); savePrefs({ groups: v }); };
  const setHide = (v) => { setHideSeen(v); savePrefs({ hideSeen: v }); };
  const setBrand = (v) => { setBrandState(v); savePrefs({ brand: v }); };

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
        <StatusBar style={T.dark ? 'light' : 'dark'} />
        <Background T={T} />
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <Screen key={mode}>
            <ScrollView contentContainerStyle={s.loginBox} keyboardShouldPersistTaps="handled">
              <Text style={s.loginTitle}>{isUp ? tr('Создать аккаунт') : t(tr('С возвращением'))}</Text>
              <TextInput
                style={s.loginInput}
                placeholder={tr('Логин')}
                placeholderTextColor={T.ph}
                autoCapitalize="none"
                autoCorrect={false}
                value={fLogin}
                onChangeText={setFLogin}
              />
              <TextInput
                style={[s.loginInput, { marginTop: 10 }]}
                placeholder={tr('Пароль (минимум 6 символов)')}
                placeholderTextColor={T.ph}
                secureTextEntry
                value={fPass}
                onChangeText={setFPass}
                onSubmitEditing={isUp ? signUp : signIn}
              />
              {isUp ? <Text style={s.loginHint}>{tr('По логину вас найдут друзья. Латиница, цифры, точка или _')}</Text> : null}
              {status ? <Text style={s.loginErr}>{status}</Text> : null}
              <Goo onPress={busy ? undefined : isUp ? signUp : signIn} style={s.loginBtn}>
                {busy ? <ActivityIndicator color={T.onAccent} /> : <Text style={s.loginBtnText}>{isUp ? tr('Далее') : t(tr('Войти'))}</Text>}
              </Goo>
              <Pressable onPress={() => { setMode(isUp ? 'signin' : 'signup'); setStatus(''); }} style={{ marginTop: 16, alignItems: 'center' }}>
                <Text style={s.switchText}>{isUp ? tr('Уже есть аккаунт? Войти') : t(tr('Нет аккаунта? Зарегистрироваться'))}</Text>
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
        <StatusBar style={T.dark ? 'light' : 'dark'} />
        <Background T={T} />
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <Screen key="setup">
            <ScrollView contentContainerStyle={s.loginBox} keyboardShouldPersistTaps="handled">
              <Text style={s.loginTitle}>{tr('Давайте познакомимся')}</Text>
              <Text style={s.setupLabel}>{tr('Как вас зовут?')}</Text>
              <TextInput style={s.loginInput} placeholder={tr('Имя')} placeholderTextColor={T.ph} value={fName} onChangeText={setFName} />
              <Text style={[s.setupLabel, { marginTop: 18 }]}>{tr('Как вы хотите, чтобы видели ваше имя?')}</Text>
              <TextInput style={s.loginInput} placeholder={fName.trim() ? t(tr('Никнейм, например ')) + fName.trim() : t(tr('Никнейм'))} placeholderTextColor={T.ph} value={fNick} onChangeText={setFNick} />
              <Text style={s.loginHint}>{tr('Никнейм видят собеседники. Можно оставить пустым — тогда будет имя.')}</Text>
              {status ? <Text style={s.loginErr}>{status}</Text> : null}
              <Goo onPress={busy ? undefined : finishSetup} style={s.loginBtn}>
                {busy ? <ActivityIndicator color={T.onAccent} /> : <Text style={s.loginBtnText}>{tr('Готово')}</Text>}
              </Goo>
            </ScrollView>
          </Screen>
        </KeyboardAvoidingView>
      </View>
    );
  }

  // ----- Чаты (список) -----
  const chatRow = (c) => {
    const o = otherOf(c);
    const fresh = unread(c);
    const tw = typingWho(c);
    const pre = c.lastFrom === user.uid ? tr('Вы: ') : c.group && c.lastFrom ? memberName(c, c.lastFrom) + ': ' : '';
    return (
      <Goo key={c.id} onPress={() => openChat(c)} style={s.card} depth={0.97}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <View style={{ marginRight: 12 }}><Avatar p={o} size={44} s={s} /></View>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Text style={s.cardWhoTop} numberOfLines={1}>{c.group ? '👥 ' : ''}{o.nick}</Text>
              <Text style={s.cardLabel}>{fmtTime(c.lastTs)}</Text>
            </View>
            <Text style={[s.cardText, fresh && { fontWeight: '700' }, tw && { color: '#2f8cff' }]} numberOfLines={1}>
              {tw || (c.lastText ? pre + c.lastText : t(tr('Пока нет сообщений')))}
            </Text>
          </View>
          {fresh ? <View style={s.dot} /> : null}
        </View>
      </Goo>
    );
  };
  const renderHome = () => (
    <Screen key="chats">
      <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 4 }} keyboardShouldPersistTaps="handled">
        {chats.length ? null : <Text style={s.helloSub}>{tr('Пока нет переписок. Нажмите «+», чтобы найти собеседника')}</Text>}
        {chats.map(chatRow)}
      </ScrollView>
    </Screen>
  );

  // ----- Чат -----
  const renderChat = () => {
    if (!chat) {
      return (
        <Screen key="nochat">
          <View style={s.center}><Text style={s.placeholder}>{tr('Выберите переписку на Главной')}</Text></View>
        </Screen>
      );
    }
    const o = otherOf(chat);
    const theirRead = readByOthers(chat);
    const tw = typingWho(chat);
    const sub = tw || (chat.group ? (chat.members || []).length + tr(' участн.') : seenLabel(o.seen) || (o.login ? '@' + o.login : ''));
    return (
      <View style={{ flex: 1 }}>
        <View style={s.chatHeader}>
          <Pressable onPress={closeChat} hitSlop={12} style={s.backBtn}>
            <Text style={s.backText}>‹</Text>
          </Pressable>
          <Avatar p={o} size={34} s={s} />
          <View style={{ marginLeft: 10, flex: 1 }}>
            <Text style={s.chatName} numberOfLines={1}>{o.nick}</Text>
            <Text style={[s.chatSub, (tw || sub === tr('в сети')) && { color: '#2f8cff' }]} numberOfLines={1}>{sub}</Text>
          </View>
        </View>
        {status ? <Text style={s.status}>{status}</Text> : null}
        <ScrollView
          ref={scrollRef}
          onContentSizeChange={() => scrollRef.current && scrollRef.current.scrollToEnd({ animated: true })}
          contentContainerStyle={{ paddingHorizontal: 12, paddingTop: 10, paddingBottom: 6 }}
          keyboardShouldPersistTaps="handled"
        >
          {messages.length === 0 ? <Text style={s.emptyChat}>{tr('Напишите первое сообщение')}</Text> : null}
          {messages.map((m, i) => (
            <View key={m.id} onLayout={(e) => { msgY.current[m.id] = e.nativeEvent.layout.y; }}>
            {i === 0 || dayLabel(messages[i - 1].ts) !== dayLabel(m.ts) ? (
              <View style={s.dayChip}><Text style={s.dayText}>{dayLabel(m.ts)}</Text></View>
            ) : null}
            <Message
              m={m}
              mine={m.from === user.uid}
              seen={m.ts <= theirRead}
              open={picker === m.id}
              onOpen={() => !m.pending && setPicker(m.id)}
              onClose={() => setPicker(null)}
              onReact={react}
              onMedia={openMedia}
              onReply={startReply}
              onEdit={startEdit}
              onDelete={removeMsg}
              onQuote={jumpTo}
              replyName={nameOf}
              who={chat.group ? memberName(chat, m.from) : ''}
              getUrl={getUrl}
              loadingMedia={loadingMedia === m.id}
              s={s}
              T={T}
            />
            </View>
          ))}
        </ScrollView>
        {sendingMedia ? <Text style={s.sendingNote}>{sendingMedia}</Text> : null}
        {replyTo || editing ? (
          <View style={s.replyBar}>
            <View style={s.replyLine} />
            <View style={{ flex: 1 }}>
              <Text style={s.quoteWho} numberOfLines={1}>{editing ? tr('Редактирование') : t(tr('Ответ: ')) + nameOf(replyTo.from)}</Text>
              <Text style={s.quoteText} numberOfLines={1}>{(editing || replyTo).text || ((editing || replyTo).img ? tr('📷 Фото') : t(tr('🎬 Видео')))}</Text>
            </View>
            <Pressable onPress={() => { if (editing) setText(''); setReplyTo(null); setEditing(null); }} hitSlop={10} style={{ paddingHorizontal: 8 }}>
              <Text style={s.findCloseText}>×</Text>
            </Pressable>
          </View>
        ) : null}
        {rec && rec.kind === 'circle' && IS_WEB ? (
          <View style={s.recCircleWrap} pointerEvents="none">
            <WebVideo autoPlay muted playsInline ref={(el) => { if (el && rec.stream && el.srcObject !== rec.stream) el.srcObject = rec.stream; }}
              style={{ width: 240, height: 240, objectFit: 'cover', borderRadius: 120, transform: 'scaleX(-1)' }} />
          </View>
        ) : null}
        {rec ? (
          <View style={[s.inputWrap, kb && { marginBottom: 8 }, { alignItems: 'center' }]}>
            <View style={s.recDot} />
            <Text style={[s.input, { flex: 1 }]}>{rec.kind === 'voice' ? tr('Голосовое') : t(tr('Кружочек'))}  {fmtDur(rec.sec)} / {fmtDur(rec.kind === 'voice' ? VOICE_MAX : CIRCLE_MAX)}</Text>
            <Pressable onPress={() => stopRec(false)} style={{ paddingHorizontal: 10 }}><Text style={[s.menuText, { color: '#e5484d' }]}>{tr('Отмена')}</Text></Pressable>
            <Goo onPress={() => stopRec(true)} style={s.sendBtnSm} depth={0.82}><Text style={s.sendTextSm}>↑</Text></Goo>
          </View>
        ) : (
        <View style={[s.inputWrap, kb && { marginBottom: 8 }]}>
          <Goo onPress={sendMedia} style={s.clipBtn} depth={0.82}>
            {sendingMedia ? <ActivityIndicator color={T.text} size="small" /> : <Text style={s.clipText}>📎</Text>}
          </Goo>
          <TextInput
            ref={inputRef}
            style={s.input}
            placeholder={tr('Сообщение')}
            placeholderTextColor={T.ph}
            value={text}
            onChangeText={onType}
            onSubmitEditing={send}
            multiline
          />
          {text.trim() || editing ? (
            <Goo onPress={send} style={s.sendBtnSm} depth={0.82}>
              <Text style={s.sendTextSm}>{editing ? '✓' : '↑'}</Text>
            </Goo>
          ) : (
            <View style={{ flexDirection: 'row' }}>
              <Goo onPress={() => startRec('circle')} style={[s.clipBtn, { marginRight: 4 }]} depth={0.82}><Text style={s.clipText}>⭕</Text></Goo>
              <Goo onPress={() => startRec('voice')} style={s.sendBtnSm} depth={0.82}><Text style={s.sendTextSm}>🎤</Text></Goo>
            </View>
          )}
        </View>
        )}
      </View>
    );
  };

  // ----- Настройки -----
  const Seg = ({ value, label }) => (
    <Pressable onPress={() => setTheme(value)} style={[s.seg, themePref === value && s.segOn]}>
      <Text style={[s.segText, themePref === value && s.segTextOn]}>{label}</Text>
    </Pressable>
  );
  const renderGroups = () => (
    <Screen key="groups">
      <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 4 }} keyboardShouldPersistTaps="handled">
        <View style={s.card}>
          <Text style={s.sectionTitle}>{tr('Новая группа')}</Text>
          <TextInput style={s.gInput} placeholder={tr('Название')} placeholderTextColor={T.ph} value={gTitle} onChangeText={setGTitle} />
          <TextInput style={s.gInput} placeholder={tr('Логины участников через запятую')} placeholderTextColor={T.ph} value={gLogins} onChangeText={setGLogins} autoCapitalize="none" autoCorrect={false} />
          {gMsg ? <Text style={[s.cardLabel, { marginTop: 6 }]}>{gMsg}</Text> : null}
          <Goo onPress={gBusy ? undefined : createGroup} style={[s.bigBtn, { marginTop: 10 }]} depth={0.94}>
            {gBusy ? <ActivityIndicator color={T.onAccent} /> : <Text style={s.bigBtnText}>{tr('Создать')}</Text>}
          </Goo>
        </View>
        {chats.filter((c) => c.group).map(chatRow)}
      </ScrollView>
    </Screen>
  );

  const Row = ({ icon, color, label, value, onPress, last, danger, right }) => (
    <Pressable onPress={onPress} style={({ pressed }) => [s.sRow, pressed && onPress ? { backgroundColor: T.glassLine } : null]}>
      {icon ? <View style={[s.sIcon, { backgroundColor: color }]}><Text style={s.sIconText}>{icon}</Text></View> : null}
      <View style={[s.sRowBody, !last && s.sRowLine]}>
        <Text style={[s.sRowText, danger && s.sDanger]} numberOfLines={1}>{label}</Text>
        {value ? <Text style={s.sRowValue} numberOfLines={1}>{value}</Text> : null}
        {right || (onPress && !danger ? <Text style={s.sChevron}>›</Text> : null)}
      </View>
    </Pressable>
  );
  const Group = ({ children }) => <View style={s.sGroup}>{children}</View>;
  const PAGES = { notify: t(tr('Уведомления')), privacy: t(tr('Конфиденциальность')), data: t(tr('Данные и память')), look: t(tr('Оформление')), lang: t(tr('Язык')), tips: t(tr('Возможности')) };
  const themeName = { light: t(tr('Светлая')), dark: t(tr('Тёмная')), system: t(tr('Как в системе')) }[themePref];
  const clearCache = () => {
    Object.keys(blobCache).forEach((k) => { try { URL.revokeObjectURL(blobCache[k]); } catch (e) {} delete blobCache[k]; });
    setStatus(tr('Кэш медиа очищен'));
    setTimeout(() => setStatus(''), 2000);
  };

  const renderSettingsPage = () => (
    <Screen key={'set-' + setPage}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 4 }}>
        <Pressable onPress={() => setSetPage(null)} hitSlop={10} style={{ marginBottom: 12 }}>
          <Text style={s.sBack}>{tr('‹ Настройки')}</Text>
        </Pressable>
        <Text style={s.sPageTitle}>{PAGES[setPage]}</Text>

        {setPage === 'notify' ? (
          <>
            <Group>
              <Row icon="🔔" color="#ff5a5f" label={tr('Уведомления')} last right={<Switch value={pushOn} onValueChange={setPush} />} />
            </Group>
            <Text style={s.sHint}>{projectId() ? tr('О новых сообщениях, когда приложение закрыто.') : t(tr('Заработают после подключения Expo в сборке.'))}</Text>
            <Group>
              <Row icon="🧪" color="#5b7cfa" label={tr('Проверить уведомления')} onPress={testPush} last />
            </Group>
            {pushDiag ? <Text selectable style={s.sHint}>{pushDiag}</Text> : null}
          </>
        ) : null}

        {setPage === 'privacy' ? (
          <>
            <Group>
              <Row icon="👁" color="#8e8e93" label={tr('Скрывать «в сети»')} last right={<Switch value={hideSeen} onValueChange={setHide} />} />
            </Group>
            <Text style={s.sHint}>{tr('Собеседники не увидят, когда вы были в сети.')}</Text>
          </>
        ) : null}

        {setPage === 'data' ? (
          <>
            <Group>
              <Row icon="🗂" color="#34c759" label={tr('Голосовые и кружочки в кэше')} value={String(Object.keys(blobCache).length)} />
              <Row icon="🧹" color="#ff9f0a" label={tr('Очистить кэш медиа')} onPress={clearCache} last />
            </Group>
            <Text style={s.sHint}>{tr('Файлы остаются в переписке и загрузятся снова при открытии.')}</Text>
          </>
        ) : null}

        {setPage === 'look' ? (
          <>
            <Group>
              {['light', 'dark', 'system'].map((v, i) => (
                <Row key={v} label={{ light: t(tr('Светлая')), dark: t(tr('Тёмная')), system: t(tr('Как в системе')) }[v]} onPress={() => setTheme(v)} last={i === 2}
                  right={themePref === v ? <Text style={s.sCheck}>✓</Text> : <View />} />
              ))}
            </Group>
            <Text style={[s.sHint, { marginTop: 0, marginBottom: 8 }]}>{tr('Цвет приложения')}</Text>
            <View style={[s.sGroup, { flexDirection: 'row', justifyContent: 'space-around', paddingVertical: 16 }]}>
              {Object.keys(BRANDS).map((k) => (
                <Pressable key={k} onPress={() => setBrand(k)} style={{ alignItems: 'center' }}>
                  <View style={[s.swatch, brand === k && s.swatchOn]}>
                    {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
                      <View key={i} style={{ flex: 1, backgroundColor: colorAt(BRANDS[k].grad, i / 7) }} />
                    ))}
                  </View>
                  <Text style={[s.sRowValue, { marginTop: 6, marginRight: 0 }, brand === k && { color: T.text, fontWeight: '700' }]}>{BRANDS[k].name}</Text>
                </Pressable>
              ))}
            </View>
            <Group>
              <Row icon="👥" color="#5b7cfa" label={tr('Кнопка «Группы»')} last right={<Switch value={groupsOn} onValueChange={setGroups} />} />
            </Group>
            <Text style={s.sHint}>{tr('Показывать вкладку «Группы» в нижней панели.')}</Text>
          </>
        ) : null}

        {setPage === 'lang' ? (
          <Group>
            <Row label={(RU ? tr('Русский') : 'English')} last right={<Text style={s.sCheck}>✓</Text>} onPress={() => {}} />
          </Group>
        ) : null}

        {setPage === 'tips' ? (
          <Group>
            {[
              ['↩️', t(tr('Свайп сообщения влево — ответить'))],
              ['❤️', t(tr('Двойное нажатие — реакция'))],
              ['✋', t(tr('Долгое нажатие — ответить, изменить, удалить'))],
              ['🎤', t(tr('Голосовое — кнопка справа от поля'))],
              ['⭕', t(tr('Кружочек — видео до 30 секунд'))],
              ['👥', t(tr('Группы — включаются в «Оформлении»'))],
            ].map(([ic, t], i, arr) => <Row key={t} icon={ic} color="rgba(127,127,127,0.25)" label={t} last={i === arr.length - 1} />)}
          </Group>
        ) : null}
      </ScrollView>
    </Screen>
  );

  const renderSettings = () => (setPage ? renderSettingsPage() : (
    <Screen key="settings">
      <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 0 }}>
        <View style={{ alignItems: 'center', marginBottom: 18 }}>
          <Pressable onPress={pickAvatar}><Avatar p={me} size={104} s={s} /></Pressable>
          <Text style={s.sName}>{shown(me)}</Text>
          <Text style={s.sSub}>{[user.login ? '@' + user.login : '', user.email].filter(Boolean).join(' • ')}</Text>
        </View>

        <Group>
          <Row icon="📷" color="#5b7cfa" label={tr('Изменить фотографию')} onPress={pickAvatar} last />
        </Group>

        <Group>
          <Row icon="👤" color="#ff5a5f" label={tr('Мой профиль')} onPress={openEdit} last />
        </Group>

        <Group>
          <Row icon="🔔" color="#ff3b30" label={tr('Уведомления')} value={pushOn ? tr('Вкл.') : t(tr('Выкл.'))} onPress={() => setSetPage('notify')} />
          <Row icon="🔒" color="#8e8e93" label={tr('Конфиденциальность')} onPress={() => setSetPage('privacy')} />
          <Row icon="💾" color="#34c759" label={tr('Данные и память')} onPress={() => setSetPage('data')} />
          <Row icon="🎨" color="#32ade6" label={tr('Оформление')} value={BRANDS[brand].name} onPress={() => setSetPage('look')} />
          <Row icon="🌐" color="#af52de" label={tr('Язык')} value={(RU ? tr('Русский') : 'English')} onPress={() => setSetPage('lang')} last />
        </Group>

        <Group>
          <Row icon="💡" color="#ffcc00" label={tr('Возможности')} onPress={() => setSetPage('tips')} last />
        </Group>

        <Group>
          <Row label={tr('Выйти')} onPress={logout} danger last />
        </Group>
        <Text style={s.sVersion}>{tr('Версия')} {APP_VERSION}</Text>
      </ScrollView>
    </Screen>
  ));

  const totalUnread = chats.filter(unread).length;

  return (
    <View style={s.root}>
      <StatusBar style={T.dark ? 'light' : 'dark'} />
      <Background T={T} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        {!inChat ? (
          <View style={s.top}>
            <Text style={s.topTitle}>{tr(tab)}</Text>
            {tab !== 'Настройки' ? (
              <Pressable onPress={openEdit} hitSlop={8}>
                <Avatar p={me} size={38} s={s} />
              </Pressable>
            ) : <View style={{ height: 38 }} />}
          </View>
        ) : null}

        {!inChat && status ? <Text style={s.status}>{status}</Text> : null}

        <View style={{ flex: 1 }}>
          {tab === 'Чаты' ? (chat ? renderChat() : renderHome()) : tab === 'Группы' ? renderGroups() : renderSettings()}
        </View>

        {(!kb || finding) && !inChat ? (
          <View style={s.tabBarWrap}>
            <View style={{ width: ROW_W, height: PLUS, flexDirection: 'row', alignItems: 'center' }}>
              <Animated.View
                pointerEvents={finding ? 'none' : 'auto'}
                style={{
                  opacity: fo.interpolate({ inputRange: [0, 0.75, 1], outputRange: [1, 0.6, 0] }),
                  transform: [
                    { translateX: fo.interpolate({ inputRange: [0, 1], outputRange: [0, -(ROW_W + 40)] }) },
                    { scaleX: fo.interpolate({ inputRange: [0, 0.35, 0.7, 1], outputRange: [1, 0.86, 0.62, 0.4] }) },
                    { scaleY: fo.interpolate({ inputRange: [0, 0.35, 0.7, 1], outputRange: [1, 1.12, 0.9, 0.7] }) },
                  ],
                }}
              >
                <View style={{ width: ROW_W, height: PLUS }}>
                  {ALL_TABS.map((t) => (
                    <Animated.View key={'bg' + t} pointerEvents="none" style={[s.dot0, { left: xs.current[t], opacity: vis[t], transform: [{ scale: vis[t] }] }]} />
                  ))}
                  <Animated.View
                    pointerEvents="none"
                    style={[s.indicator, {
                      left: ixL,
                      width: Animated.add(Animated.subtract(ixR, ixL), -6),
                      transform: [{ scaleY: squish }],
                    }]}
                  />
                  {ALL_TABS.map((t) => (
                    <Animated.View key={t} pointerEvents={TABS.includes(t) ? 'auto' : 'none'} style={[s.tabItem, { left: xs.current[t], opacity: vis[t], transform: [{ scale: vis[t] }] }]}>
                      <Goo onPress={() => go(t)} style={s.tabTap} depth={0.86}>
                        <Text style={[s.tabIcon, tab !== t && { opacity: 0.55 }]}>{TAB_ICON[t]}</Text>
                        {t === 'Чаты' && totalUnread > 0 && (tab !== 'Чаты' || chat) ? <View style={s.tabDot} /> : null}
                      </Goo>
                    </Animated.View>
                  ))}
                </View>
              </Animated.View>
              <Animated.View
                style={[
                  s.plusWrap,
                  {
                    left: Animated.multiply(xs.current.plus, Animated.subtract(1, fo)),
                    width: fo.interpolate({ inputRange: [0, 1], outputRange: [PLUS, ROW_W] }),
                    borderRadius: PLUS / 2,
                    transform: [{ scaleY: goo.interpolate({ inputRange: [1, 1.2], outputRange: [1, 0.86] }) }, { scaleX: goo }],
                  },
                ]}
              >
                {finding ? (
                  <Animated.View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', opacity: fo.interpolate({ inputRange: [0, 0.6, 1], outputRange: [0, 0, 1] }) }}>
                    <Pressable onPress={closeFind} hitSlop={10} style={s.findClose}>
                      <Text style={s.findCloseText}>×</Text>
                    </Pressable>
                    <TextInput
                      ref={findRef}
                      style={s.findInput}
                      placeholder={tr('Найти Кирилла')}
                      placeholderTextColor={T.ph}
                      autoCapitalize="none"
                      autoCorrect={false}
                      value={findLogin}
                      onChangeText={setFindLogin}
                      onSubmitEditing={startChat}
                      returnKeyType="search"
                    />
                  </Animated.View>
                ) : <View style={{ flex: 1 }} />}
                <Goo onPress={busy ? undefined : finding ? startChat : openFind} style={s.plusBtn} depth={0.82}>
                  {busy ? <ActivityIndicator color={T.onAccent} /> : (
                    <Animated.Text style={[s.sendText, { transform: [{ rotate: fo.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '180deg'] }) }] }]}>
                      {finding ? '→' : '+'}
                    </Animated.Text>
                  )}
                </Goo>
              </Animated.View>
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
          <Text style={s.viewerClose}>{tr('Нажмите, чтобы закрыть')}</Text>
        </Pressable>
      </Modal>

      {/* Редактирование профиля */}
      <Modal visible={editOpen} transparent statusBarTranslucent navigationBarTranslucent animationType="slide" onRequestClose={() => setEditOpen(false)}>
        <View style={s.sheetBack}>
          <ScrollView contentContainerStyle={s.sheet} keyboardShouldPersistTaps="handled">
            <Text style={s.sheetTitle}>{tr('Профиль')}</Text>
            <View style={{ alignItems: 'center', marginBottom: 14 }}>
              <Pressable onPress={pickAvatar}>
                <Avatar p={{ ...edit, nick: edit.nick || edit.name }} size={96} s={s} />
              </Pressable>
              <View style={{ flexDirection: 'row', marginTop: 10 }}>
                <Pressable onPress={pickAvatar} style={s.smallBtn}><Text style={s.smallBtnText}>{tr('Выбрать фото')}</Text></Pressable>
                {edit.avatar ? (
                  <Pressable onPress={() => setEdit((e) => ({ ...e, avatar: '' }))} style={[s.smallBtn, { marginLeft: 8 }]}>
                    <Text style={s.smallBtnText}>{tr('Убрать фото')}</Text>
                  </Pressable>
                ) : null}
              </View>
            </View>
            <Text style={s.cardLabel}>{tr('Цвет аватара')}</Text>
            <View style={s.colorRow}>
              {AV_COLORS.map((c) => (
                <Pressable key={c} onPress={() => setEdit((e) => ({ ...e, color: c }))} style={[s.colorDot, { backgroundColor: c }, edit.color === c && s.colorDotOn]} />
              ))}
            </View>
            <Text style={[s.cardLabel, { marginTop: 14 }]}>{tr('Имя')}</Text>
            <TextInput style={s.sheetInput} value={edit.name} onChangeText={(v) => setEdit((e) => ({ ...e, name: v }))} placeholder={tr('Имя')} placeholderTextColor={T.ph} />
            <Text style={[s.cardLabel, { marginTop: 12 }]}>{tr('Никнейм — так вас видят собеседники')}</Text>
            <TextInput style={s.sheetInput} value={edit.nick} onChangeText={(v) => setEdit((e) => ({ ...e, nick: v }))} placeholder={tr('Никнейм')} placeholderTextColor={T.ph} />
            <Text style={[s.cardLabel, { marginTop: 12 }]}>{tr('Логин:')} {user.login ? '@' + user.login : user.email}</Text>
            {status ? <Text style={[s.cardLabel, { color: '#d9534f', marginTop: 8 }]}>{status}</Text> : null}
            <View style={{ flexDirection: 'row', marginTop: 18 }}>
              <Pressable onPress={() => setEditOpen(false)} style={[s.sheetBtn, { backgroundColor: T.soft, marginRight: 10 }]}>
                <Text style={[s.sheetBtnText, { color: T.text }]}>{tr('Отмена')}</Text>
              </Pressable>
              <Pressable onPress={busy ? undefined : saveEdit} style={[s.sheetBtn, { backgroundColor: T.accent }]}>
                {busy ? <ActivityIndicator color={T.onAccent} /> : <Text style={[s.sheetBtnText, { color: T.onAccent }]}>{tr('Сохранить')}</Text>}
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
  const glassFx = {};
  const vol = { borderWidth: 1, borderColor: 'rgba(255,255,255,0.30)', borderBottomColor: 'rgba(0,0,0,0.28)', shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.28, shadowRadius: 6, elevation: 6 };
  return StyleSheet.create({
    root: { flex: 1 },
    top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: TOP + 8, paddingHorizontal: 18, paddingBottom: 4 },
    topTitle: { color: T.text, fontSize: 24, fontWeight: '800' },
    avatarBase: { alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.35)' },
    status: { color: T.text, textAlign: 'center', fontSize: 12, paddingHorizontal: 16, paddingTop: 4 },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    placeholder: { color: T.text, fontSize: 15 },

    hello: { color: T.text, fontSize: 28, fontWeight: '800' },
    helloSub: { color: 'rgba(255,255,255,0.9)', fontSize: 14, marginTop: 2, marginBottom: 14 },
    card: { backgroundColor: T.glass, borderRadius: 22, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: T.glassEdge, ...glassFx },
    swatch: { width: 54, height: 54, borderRadius: 27, overflow: 'hidden', borderWidth: 2, borderColor: 'transparent' },
    swatchOn: { borderColor: '#fff', transform: [{ scale: 1.08 }] },
    sGroupOuter: {},
    sGroup: { backgroundColor: T.glass, borderRadius: 24, marginBottom: 16, borderWidth: 1, borderColor: T.glassEdge, ...glassFx, ...lift },
    sDanger: { color: '#e0242b', fontWeight: '800' },
    sVersion: { textAlign: 'center', marginTop: 4, marginBottom: 20, fontSize: 13, fontWeight: '700', color: T.text },
    sRow: { flexDirection: 'row', alignItems: 'center', paddingLeft: 14, minHeight: 52, borderRadius: 22 },
    sIcon: { width: 30, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center', marginRight: 12, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.25, shadowRadius: 4, elevation: 3 },
    sIconText: { fontSize: 16 },
    sRowBody: { flex: 1, flexDirection: 'row', alignItems: 'center', minHeight: 52, paddingRight: 14 },
    sRowLine: { borderBottomWidth: 1, borderBottomColor: T.glassLine },
    sRowText: { flex: 1, fontSize: 16, color: T.text, fontWeight: '600' },
    sRowValue: { fontSize: 15, color: T.text, fontWeight: '600', marginRight: 6 },
    sChevron: { fontSize: 22, color: T.text, fontWeight: '700', marginTop: -2 },
    sCheck: { fontSize: 17, color: '#2f8cff', fontWeight: '800' },
    sName: { fontSize: 28, fontWeight: '800', color: T.text, marginTop: 12 },
    sSub: { fontSize: 15, color: T.sub, marginTop: 4 },
    sHint: { fontSize: 13, color: T.sub, marginTop: -8, marginBottom: 16, marginHorizontal: 14 },
    sBack: { color: T.text, fontSize: 17, fontWeight: '600' },
    sPageTitle: { color: T.text, fontSize: 26, fontWeight: '800', marginBottom: 14, marginLeft: 4 },
    cardLabel: { fontSize: 12, color: T.sub, fontWeight: '600' },
    cardWhoTop: { fontSize: 15, color: T.text, fontWeight: '800', flexShrink: 1 },
    cardText: { fontSize: 14, color: T.text, marginTop: 2, opacity: 0.85 },
    dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: '#2f6fd6', marginLeft: 10 },
    sectionTitle: { fontSize: 15, color: T.text, fontWeight: '800', marginBottom: 4 },
    bigBtn: { backgroundColor: T.accent, borderRadius: 24, height: 50, alignItems: 'center', justifyContent: 'center', marginTop: 6, ...lift, ...vol },
    bigBtnText: { color: T.onAccent, fontSize: 16, fontWeight: '700' },

    segRow: { flexDirection: 'row', backgroundColor: T.soft, borderRadius: 16, padding: 3, marginTop: 6 },
    seg: { flex: 1, height: 36, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
    segOn: { backgroundColor: T.accent, ...vol },
    segText: { fontSize: 13, color: T.text, fontWeight: '600' },
    segTextOn: { color: T.onAccent },

    findRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: T.card, borderRadius: 26, paddingLeft: 16, paddingRight: 5, height: 50, marginBottom: 14, ...lift, ...edge },
    findInput: { flex: 1, fontSize: 15, color: T.text, paddingVertical: 0, height: PLUS },
    plusWrap: { position: 'absolute', top: 0, height: PLUS, flexDirection: 'row', alignItems: 'center', backgroundColor: T.tabBar, overflow: 'hidden', ...lift, ...edge },
    plusBtn: { width: PLUS - 6, height: PLUS - 6, borderRadius: (PLUS - 6) / 2, margin: 3, backgroundColor: T.accent, alignItems: 'center', justifyContent: 'center', ...vol },
    findClose: { width: 34, height: PLUS, alignItems: 'center', justifyContent: 'center', marginLeft: 6 },
    findCloseText: { fontSize: 22, color: T.tabText, fontWeight: '600' },

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
    voiceBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: T.accent, alignItems: 'center', justifyContent: 'center', ...vol },
    voiceBtnText: { color: T.onAccent, fontSize: 14, fontWeight: '800' },
    circle: { width: CIRCLE, height: CIRCLE, borderRadius: CIRCLE / 2, overflow: 'hidden', backgroundColor: '#1b1d24', alignItems: 'center', justifyContent: 'center', ...lift },
    circleMeta: { backgroundColor: 'rgba(0,0,0,0.45)', color: '#fff', paddingHorizontal: 6, borderRadius: 8, overflow: 'hidden', marginTop: 4 },
    recCircleWrap: { alignItems: 'center', marginBottom: 10 },
    recDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: '#e5484d', marginLeft: 10 },
    gInput: { backgroundColor: T.soft, borderRadius: 14, paddingHorizontal: 12, height: 42, color: T.text, fontSize: 15, marginTop: 8 },
    menu: { backgroundColor: T.card, borderRadius: 16, paddingVertical: 4, marginBottom: 8, minWidth: 170, ...lift, ...edge },
    menuItem: { paddingHorizontal: 14, paddingVertical: 9 },
    menuText: { fontSize: 15, color: T.text, fontWeight: '600' },
    quote: { borderLeftWidth: 3, borderLeftColor: '#2f8cff', paddingLeft: 8, paddingVertical: 2, marginBottom: 4, borderRadius: 3, backgroundColor: 'rgba(47,140,255,0.10)' },
    quoteWho: { fontSize: 12, fontWeight: '800', color: '#2f8cff' },
    quoteText: { fontSize: 13, color: T.sub },
    replyBar: { flexDirection: 'row', alignItems: 'center', backgroundColor: T.card, marginHorizontal: 10, marginBottom: 6, borderRadius: 16, paddingVertical: 6, paddingLeft: 10, ...edge },
    replyLine: { width: 3, alignSelf: 'stretch', borderRadius: 2, backgroundColor: '#2f8cff', marginRight: 8 },
    dayChip: { alignSelf: 'center', backgroundColor: T.dark ? '#1c1c1f' : 'rgba(0,0,0,0.35)', borderRadius: 12, paddingHorizontal: 10, paddingVertical: 3, marginVertical: 8 },
    dayText: { color: '#fff', fontSize: 12, fontWeight: '700' },
    swipeIcon: { position: 'absolute', top: '40%', fontSize: 20, color: '#2f8cff' },
    picker: { flexDirection: 'row', backgroundColor: T.card, borderRadius: 26, padding: 4, marginBottom: 8, alignSelf: 'flex-start', ...lift, ...edge },
    pickBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
    pickEmoji: { fontSize: 24 },

    sendingNote: { color: T.text, fontSize: 12, textAlign: 'center', paddingBottom: 4 },
    inputWrap: { flexDirection: 'row', alignItems: 'flex-end', backgroundColor: T.card, borderRadius: 22, marginHorizontal: 10, marginBottom: BOT + 8, paddingHorizontal: 4, paddingVertical: 4, minHeight: 44, ...lift, ...edge },
    input: { flex: 1, fontSize: 15, color: T.text, marginHorizontal: 6, paddingVertical: 8, maxHeight: 110 },
    clipBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: T.soft },
    clipText: { fontSize: 17 },
    sendBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: T.accent, alignItems: 'center', justifyContent: 'center', ...vol },
    sendText: { color: T.onAccent, fontSize: 20, fontWeight: '700' },
    sendBtnSm: { width: 36, height: 36, borderRadius: 18, backgroundColor: T.accent, alignItems: 'center', justifyContent: 'center', ...vol },
    sendTextSm: { color: T.onAccent, fontSize: 18, fontWeight: '700' },

    tabBarWrap: { alignItems: 'center', paddingBottom: BOT + 8, paddingTop: 4 },
    dot0: { position: 'absolute', top: 0, width: PLUS, height: PLUS, borderRadius: PLUS / 2, backgroundColor: T.tabBar, ...lift, ...edge },
    indicator: { position: 'absolute', top: 3, height: PLUS - 6, borderRadius: (PLUS - 6) / 2, backgroundColor: T.accent, marginLeft: 3, marginRight: 3, ...vol },
    tabItem: { position: 'absolute', top: 0, width: PLUS, height: PLUS },
    tabTap: { width: PLUS, height: PLUS, borderRadius: PLUS / 2, alignItems: 'center', justifyContent: 'center' },
    tabIcon: { fontSize: 22 },
    tabDot: { position: 'absolute', top: 8, right: 8, width: 9, height: 9, borderRadius: 5, backgroundColor: '#2f6fd6' },

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
    loginTitle: { color: T.text, fontSize: 28, fontWeight: '800', marginBottom: 16 },
    setupLabel: { color: T.text, fontSize: 15, fontWeight: '700', marginBottom: 8 },
    loginInput: { backgroundColor: T.card, borderRadius: 24, height: 50, paddingHorizontal: 18, fontSize: 16, color: T.text, ...lift, ...edge },
    loginHint: { color: 'rgba(255,255,255,0.85)', fontSize: 12, marginTop: 8 },
    loginErr: { color: T.text, marginTop: 10, fontSize: 13, fontWeight: '700' },
    loginBtn: { backgroundColor: T.accent, borderRadius: 24, height: 50, alignItems: 'center', justifyContent: 'center', marginTop: 14, ...lift, ...vol },
    loginBtnText: { color: T.onAccent, fontSize: 16, fontWeight: '700' },
    switchText: { color: T.text, fontSize: 14, fontWeight: '600', textDecorationLine: 'underline' },
  });
}