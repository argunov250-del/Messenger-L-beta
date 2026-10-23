import React, { useState, useEffect, useRef } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, KeyboardAvoidingView, Platform, StyleSheet } from 'react-native';

const BASE = 'https://firestore.googleapis.com/v1/projects/messenger-a8377/databases/(default)/documents/messages';

const stops = [[65, 113, 154], [109, 126, 122], [232, 192, 112]];
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const colorAt = (t) => {
  const [a, b, k] = t < 0.5 ? [stops[0], stops[1], t * 2] : [stops[1], stops[2], (t - 0.5) * 2];
  return 'rgb(' + mix(a, b, k).join(',') + ')';
};

const TABS = ['Главная', 'Чат', 'Проекты'];

const s = StyleSheet.create({
  root: { flex: 1 },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', paddingTop: 64, paddingHorizontal: 16, gap: 12 },
  pill: { flexDirection: 'row', backgroundColor: 'rgba(255,255,255,0.35)', borderRadius: 30, padding: 4 },
  tab: { paddingVertical: 10, paddingHorizontal: 14, borderRadius: 26 },
  tabActive: { backgroundColor: '#1c1c1e' },
  tabText: { fontSize: 16, color: '#5f6f7a', fontWeight: '600' },
  tabTextActive: { color: '#fff' },
  avatar: { width: 48, height: 48, borderRadius: 24, backgroundColor: '#2b2b2b' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  placeholder: { color: '#fff', fontSize: 16 },
  status: { color: '#fff', textAlign: 'center', fontSize: 13, paddingHorizontal: 20, paddingTop: 6 },
  bubble: { maxWidth: '78%', padding: 12, borderRadius: 20, marginBottom: 8 },
  mine: { alignSelf: 'flex-end', backgroundColor: 'rgba(255,248,230,0.92)' },
  theirs: { alignSelf: 'flex-start', backgroundColor: 'rgba(255,255,255,0.55)' },
  who: { fontSize: 12, color: '#6a6a6a', marginBottom: 2 },
  bubbleText: { fontSize: 16, color: '#222' },
  inputWrap: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,248,230,0.9)', borderRadius: 32, marginHorizontal: 16, marginBottom: 34, paddingLeft: 20, paddingRight: 6, height: 60 },
  input: { flex: 1, fontSize: 17, color: '#222' },
  sendBtn: { width: 46, height: 46, borderRadius: 23, backgroundColor: '#1c1c1e', alignItems: 'center', justifyContent: 'center' },
  sendText: { color: '#fff', fontSize: 22, fontWeight: '700' },
  loginBox: { flex: 1, justifyContent: 'center', paddingHorizontal: 28 },
  loginTitle: { color: '#fff', fontSize: 30, fontWeight: '800', marginBottom: 16 },
  loginInput: { backgroundColor: 'rgba(255,248,230,0.92)', borderRadius: 28, height: 56, paddingHorizontal: 20, fontSize: 17, color: '#222' },
  loginBtn: { backgroundColor: '#1c1c1e', borderRadius: 28, height: 56, alignItems: 'center', justifyContent: 'center', marginTop: 12 },
  loginBtnText: { color: '#fff', fontSize: 17, fontWeight: '700' },
});

export default function App() {
  const [name, setName] = useState('');
  const [draft, setDraft] = useState('');
  const [tab, setTab] = useState('Чат');
  const [text, setText] = useState('');
  const [messages, setMessages] = useState([]);
  const [status, setStatus] = useState('');
  const scrollRef = useRef(null);

  const load = async () => {
    try {
      const res = await fetch(BASE + '?orderBy=ts%20desc&pageSize=100');
      const data = await res.json();
      if (data.error) throw new Error(data.error.message);
      const list = (data.documents || []).map((d) => ({
        id: d.name,
        text: d.fields && d.fields.text ? d.fields.text.stringValue : '',
        sender: d.fields && d.fields.sender ? d.fields.sender.stringValue : '',
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
      const res = await fetch(BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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

  const bg = (
    <View style={StyleSheet.absoluteFill}>
      {Array.from({ length: 48 }).map((_, i) => (
        <View key={i} style={{ flex: 1, backgroundColor: colorAt(i / 47) }} />
      ))}
    </View>
  );

  if (!name) {
    return (
      <View style={s.root}>
        {bg}
        <View style={s.loginBox}>
          <Text style={s.loginTitle}>Как вас зовут?</Text>
          <TextInput style={s.loginInput} placeholder="Ваше имя" placeholderTextColor="#8a8470" value={draft} onChangeText={setDraft} />
          <TouchableOpacity style={s.loginBtn} onPress={() => draft.trim() && setName(draft.trim())}>
            <Text style={s.loginBtnText}>Войти</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={s.root}>
      {bg}
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <View style={s.top}>
          <View style={s.pill}>
            {TABS.map((t) => (
              <TouchableOpacity key={t} onPress={() => setTab(t)} style={[s.tab, tab === t && s.tabActive]}>
                <Text style={[s.tabText, tab === t && s.tabTextActive]}>{t}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <View style={s.avatar} />
        </View>

        {status ? <Text style={s.status}>{status}</Text> : null}

        <View style={{ flex: 1 }}>
          {tab === 'Чат' ? (
            <ScrollView
              ref={scrollRef}
              onContentSizeChange={() => scrollRef.current && scrollRef.current.scrollToEnd({ animated: true })}
              contentContainerStyle={{ padding: 16 }}
            >
              {messages.map((m) => (
                <View key={m.id} style={[s.bubble, m.sender === name ? s.mine : s.theirs]}>
                  {m.sender !== name ? <Text style={s.who}>{m.sender}</Text> : null}
                  <Text style={s.bubbleText}>{m.text}</Text>
                </View>
              ))}
            </ScrollView>
          ) : (
            <View style={s.center}>
              <Text style={s.placeholder}>{tab}: скоро здесь что-то будет</Text>
            </View>
          )}
        </View>

        <View style={s.inputWrap}>
          <TextInput
            style={s.input}
            placeholder="Сообщение для друга"
            placeholderTextColor="#8a8470"
            value={text}
            onChangeText={setText}
            onSubmitEditing={send}
          />
          <TouchableOpacity onPress={send} style={s.sendBtn}>
            <Text style={s.sendText}>↑</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}
