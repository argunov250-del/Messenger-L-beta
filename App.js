import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TextInput, ScrollView, KeyboardAvoidingView, Platform,
  StyleSheet, Animated, Easing, Keyboard, Dimensions, Pressable,
} from 'react-native';

const DOC = 'https://firestore.googleapis.com/v1/projects/messenger-a8377/databases/(default)/documents/messages';
const HEADERS = { 'Content-Type': 'application/json' };

// Густая, тягучая кривая: медленно входит, медленно оседает
const VISC = Easing.bezier(0.22, 0.9, 0.3, 1);

const stops = [[65, 113, 154], [109, 126, 122], [232, 192, 112]];
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const colorAt = (t) => {
  const [a, b, k] = t < 0.5 ? [stops[0], stops[1], t * 2] : [stops[1], stops[2], (t - 0.5) * 2];
  return 'rgb(' + mix(a, b, k).join(',') + ')';
};

const TABS = ['Главная', 'Чат', 'Проекты'];
const EMOJIS = ['❤️', '👍', '😂', '🔥', '😮'];
const W = Dimensions.get('window').width;
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
function Message({ m, mine, open, onOpen, onClose, onReact }) {
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
      <Goo onPress={open ? onClose : undefined} onLongPress={onOpen} style={[s.bubble, mine ? s.mine : s.theirs]} depth={0.95}>
        {!mine ? <Text style={s.who}>{m.sender}</Text> : null}
        <Text style={s.bubbleText}>{m.text}</Text>
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
  const [name, setName] = useState('');
  const [draft, setDraft] = useState('');
  const [tab, setTab] = useState('Главная');
  const [text, setText] = useState('');
  const [messages, setMessages] = useState([]);
  const [status, setStatus] = useState('');
  const [picker, setPicker] = useState(null);
  const [kb, setKb] = useState(false);
  const scrollRef = useRef(null);

  const ix = useRef(new Animated.Value(0)).current;
  const stretch = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const a = Keyboard.addListener('keyboardDidShow', () => setKb(true));
    const b = Keyboard.addListener('keyboardDidHide', () => setKb(false));
    return () => { a.remove(); b.remove(); };
  }, []);

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

  const load = async () => {
    try {
      const res = await fetch(DOC + '?orderBy=ts%20desc&pageSize=100');
      const data = await res.json();
      if (data.error) throw new Error(data.error.message);
      const list = (data.documents || []).map((d) => ({
        id: d.name,
        text: d.fields && d.fields.text ? d.fields.text.stringValue : '',
        sender: d.fields && d.fields.sender ? d.fields.sender.stringValue : '',
        reaction: d.fields && d.fields.reaction ? d.fields.reaction.stringValue : '',
      })).reverse();
      setMessages(list);
      setStatus('');
    } catch (e) {
      setStatus('Нет связи: ' + e.message);
    }
  };

  useEffect(() => {
    if (!name) return;
    load();
    const timer = setInterval(load, 2500);
    return () => clearInterval(timer);
  }, [name]);

  const send = async () => {
    const t = text.trim();
    if (!t) return;
    setText('');
    try {
      const res = await fetch(DOC, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify({
          fields: {
            text: { stringValue: t },
            sender: { stringValue: name },
            ts: { integerValue: String(Date.now()) },
          },
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error.message);
      load();
    } catch (e) {
      setStatus('Не отправилось: ' + e.message);
    }
  };

  const react = async (m, emoji) => {
    const next = m.reaction === emoji ? '' : emoji;
    setPicker(null);
    setMessages((prev) => prev.map((x) => (x.id === m.id ? { ...x, reaction: next } : x)));
    try {
      const res = await fetch('https://firestore.googleapis.com/v1/' + m.id + '?updateMask.fieldPaths=reaction', {
        method: 'PATCH',
        headers: HEADERS,
        body: JSON.stringify({ fields: { reaction: { stringValue: next } } }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error.message);
    } catch (e) {
      setStatus('Реакция не отправилась: ' + e.message);
    }
  };

  // ----- Вход -----
  if (!name) {
    return (
      <View style={s.root}>
        <Background />
        <Screen>
          <View style={s.loginBox}>
            <Text style={s.loginTitle}>Как вас зовут?</Text>
            <TextInput
              style={s.loginInput}
              placeholder="Ваше имя"
              placeholderTextColor="#8a8470"
              value={draft}
              onChangeText={setDraft}
            />
            <Goo onPress={() => draft.trim() && setName(draft.trim())} style={s.loginBtn}>
              <Text style={s.loginBtnText}>Войти</Text>
            </Goo>
          </View>
        </Screen>
      </View>
    );
  }

  const last = messages.length ? messages[messages.length - 1] : null;

  const renderHome = () => (
    <Screen key="home">
      <ScrollView contentContainerStyle={{ padding: 20, paddingTop: 8 }}>
        <Text style={s.hello}>Привет, {name}</Text>
        <Text style={s.helloSub}>Здесь наш общий чат</Text>

        <Goo onPress={() => go('Чат')} style={s.card} depth={0.96}>
          <Text style={s.cardLabel}>Последнее сообщение</Text>
          {last ? (
            <View>
              <Text style={s.cardWho}>{last.sender}</Text>
              <Text style={s.cardText} numberOfLines={3}>{last.text}</Text>
            </View>
          ) : (
            <Text style={s.cardText}>Пока тишина. Напишите первым.</Text>
          )}
        </Goo>

        <View style={s.statsRow}>
          <View style={[s.card, s.statCard]}>
            <Text style={s.statNum}>{messages.length}</Text>
            <Text style={s.cardLabel}>сообщений</Text>
          </View>
          <View style={[s.card, s.statCard]}>
            <Text style={s.statNum}>{messages.filter((x) => x.reaction).length}</Text>
            <Text style={s.cardLabel}>реакций</Text>
          </View>
        </View>

        <Goo onPress={() => go('Чат')} style={s.bigBtn} depth={0.93}>
          <Text style={s.bigBtnText}>Открыть чат</Text>
        </Goo>
      </ScrollView>
    </Screen>
  );

  const renderChat = () => (
    <Screen key="chat">
      <ScrollView
        ref={scrollRef}
        onContentSizeChange={() => scrollRef.current && scrollRef.current.scrollToEnd({ animated: true })}
        contentContainerStyle={{ padding: 18, paddingTop: 10 }}
        keyboardShouldPersistTaps="handled"
      >
        {messages.map((m) => (
          <Message
            key={m.id}
            m={m}
            mine={m.sender === name}
            open={picker === m.id}
            onOpen={() => setPicker(m.id)}
            onClose={() => setPicker(null)}
            onReact={react}
          />
        ))}
      </ScrollView>
    </Screen>
  );

  const renderOther = () => (
    <Screen key="other">
      <View style={s.center}>
        <Text style={s.placeholder}>{tab}: скоро здесь что-то будет</Text>
      </View>
    </Screen>
  );

  return (
    <View style={s.root}>
      <Background />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <View style={s.top}>
          <Text style={s.topTitle}>{tab}</Text>
          <View style={s.avatar}>
            <Text style={s.avatarText}>{name.charAt(0).toUpperCase()}</Text>
          </View>
        </View>

        {status ? <Text style={s.status}>{status}</Text> : null}

        <View style={{ flex: 1 }}>
          {tab === 'Главная' ? renderHome() : tab === 'Чат' ? renderChat() : renderOther()}
        </View>

        {tab === 'Чат' ? (
          <View style={s.inputWrap}>
            <TextInput
              style={s.input}
              placeholder="Сообщение для друга"
              placeholderTextColor="#8a8470"
              value={text}
              onChangeText={setText}
              onSubmitEditing={send}
            />
            <Goo onPress={send} style={s.sendBtn} depth={0.82}>
              <Text style={s.sendText}>↑</Text>
            </Goo>
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
  helloSub: { color: 'rgba(255,255,255,0.9)', fontSize: 16, marginTop: 4, marginBottom: 22 },
  card: { backgroundColor: 'rgba(255,248,230,0.92)', borderRadius: 28, padding: 18, marginBottom: 16, ...lift, ...edge },
  cardLabel: { fontSize: 13, color: '#7b7466', fontWeight: '600' },
  cardWho: { fontSize: 15, color: '#3a3a3a', fontWeight: '700', marginTop: 10 },
  cardText: { fontSize: 17, color: '#222', marginTop: 4 },
  statsRow: { flexDirection: 'row', gap: 16 },
  statCard: { flex: 1, alignItems: 'flex-start' },
  statNum: { fontSize: 40, fontWeight: '800', color: '#1c1c1e' },
  bigBtn: { backgroundColor: '#1c1c1e', borderRadius: 32, height: 64, alignItems: 'center', justifyContent: 'center', marginTop: 6, ...lift, borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)' },
  bigBtnText: { color: '#fff', fontSize: 18, fontWeight: '700' },

  bubble: { padding: 13, borderRadius: 24, ...lift, shadowOffset: { width: 0, height: 6 }, shadowRadius: 10, elevation: 6, ...edge },
  mine: { backgroundColor: 'rgba(255,248,230,0.96)' },
  theirs: { backgroundColor: 'rgba(255,255,255,0.7)' },
  who: { fontSize: 12, color: '#6a6a6a', marginBottom: 2, fontWeight: '600' },
  bubbleText: { fontSize: 16, color: '#222' },
  badge: { position: 'absolute', bottom: -14, backgroundColor: '#fff', borderRadius: 16, paddingHorizontal: 7, paddingVertical: 3, ...lift, shadowOffset: { width: 0, height: 4 }, shadowRadius: 6, elevation: 8 },
  picker: { flexDirection: 'row', backgroundColor: 'rgba(255,255,255,0.92)', borderRadius: 30, padding: 6, marginBottom: 10, alignSelf: 'flex-start', ...lift, ...edge },
  pickBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  pickEmoji: { fontSize: 26 },

  inputWrap: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,248,230,0.94)', borderRadius: 32, marginHorizontal: 16, marginBottom: 12, paddingLeft: 20, paddingRight: 7, height: 62, ...lift, ...edge },
  input: { flex: 1, fontSize: 17, color: '#222' },
  sendBtn: { width: 48, height: 48, borderRadius: 24, backgroundColor: '#1c1c1e', alignItems: 'center', justifyContent: 'center', ...lift, shadowOffset: { width: 0, height: 5 }, shadowRadius: 8, elevation: 6 },
  sendText: { color: '#fff', fontSize: 22, fontWeight: '700' },

  tabBarWrap: { alignItems: 'center', paddingBottom: 26, paddingTop: 4 },
  tabBar: { flexDirection: 'row', backgroundColor: 'rgba(255,255,255,0.4)', borderRadius: 38, padding: 6, ...lift, ...edge },
  indicator: { position: 'absolute', left: 6, top: 6, height: 52, borderRadius: 32, backgroundColor: '#1c1c1e', shadowColor: '#000', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.35, shadowRadius: 8, elevation: 6 },
  tabItem: { height: 52, alignItems: 'center', justifyContent: 'center' },
  tabText: { fontSize: 15, color: '#42525e', fontWeight: '700' },
  tabTextActive: { color: '#fff' },

  loginBox: { flex: 1, justifyContent: 'center', paddingHorizontal: 28 },
  loginTitle: { color: '#fff', fontSize: 32, fontWeight: '800', marginBottom: 18, textShadowColor: 'rgba(0,0,0,0.25)', textShadowOffset: { width: 0, height: 3 }, textShadowRadius: 8 },
  loginInput: { backgroundColor: 'rgba(255,248,230,0.94)', borderRadius: 30, height: 58, paddingHorizontal: 22, fontSize: 17, color: '#222', ...lift, ...edge },
  loginBtn: { backgroundColor: '#1c1c1e', borderRadius: 30, height: 58, alignItems: 'center', justifyContent: 'center', marginTop: 14, ...lift },
  loginBtnText: { color: '#fff', fontSize: 17, fontWeight: '700' },
});
