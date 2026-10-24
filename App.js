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
