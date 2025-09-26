// doctor-app/App.js
import React, { useEffect, useRef, useState } from 'react';
import { SafeAreaView, View, Text, Button, StyleSheet } from 'react-native';
import AgoraUIKit from 'agora-rn-uikit';
import { io } from 'socket.io-client';

// --- CONFIG ---
const APP_ID = '60bdf4f5f1b641f583d20d28d7a923d1';
const SIGNALING_SERVER = 'https://server-w411.onrender.com';
const MY_USER_ID = 'doctor';

export default function App() {
  const socketRef = useRef(null);
  const [incomingCall, setIncomingCall] = useState(null);
  const [joined, setJoined] = useState(false);
  const [token, setToken] = useState(null);
  const [uid, setUid] = useState(null);
  const [channel, setChannel] = useState('');
  const [log, setLog] = useState('');

  useEffect(() => {
    const socket = io(SIGNALING_SERVER, { transports: ['websocket'] });
    socketRef.current = socket;
    socket.on('connect', () => {
      socket.emit('register', { userId: MY_USER_ID });
      appendLog('registered to signaling server');
    });

    socket.on('incoming_call', (payload) => {
      appendLog('incoming call from ' + payload.from);
      setIncomingCall(payload);
    });

    socket.on('call_rejected', () => {
      appendLog('caller rejected or canceled');
    });

    // peer hung up
    socket.on('end_call', () => {
      appendLog('peer ended the call');
      cleanupCall();
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  function appendLog(s) {
    setLog((l) => `${l}\n${s}`);
  }

  function cleanupCall() {
    setJoined(false);
    setChannel('');
    setToken(null);
    setUid(null);
    setIncomingCall(null);
  }

  async function acceptCall() {
    if (!incomingCall) return;
    const channelName = incomingCall.channel;
    const myUid = Math.floor(Math.random() * 1000000);
    appendLog(`accepting call, requesting token for uid ${myUid}`);

    try {
      const resp = await fetch(
        `${SIGNALING_SERVER}/rtcToken?channelName=${encodeURIComponent(channelName)}&uid=${myUid}`
      );
      const data = await resp.json();
      if (!data.rtcToken) throw new Error('no token');
      setToken(data.rtcToken);
      setUid(myUid);
      setChannel(channelName);

      socketRef.current.emit('accept_call', {
        to: incomingCall.from,
        from: MY_USER_ID,
        channel: channelName,
        calleeUid: myUid,
      });

      setIncomingCall(null);
      setJoined(true);
      appendLog('joined call');
    } catch (err) {
      appendLog('token error: ' + err.toString());
    }
  }

  function rejectCall() {
    if (!incomingCall) return;
    socketRef.current.emit('reject_call', { to: incomingCall.from, from: MY_USER_ID });
    setIncomingCall(null);
  }

  if (joined) {
    return (
      <SafeAreaView style={{ flex: 1 }}>
        <AgoraUIKit
            connectionData={{ appId: APP_ID, channel, token, uid }}
            settings={{}}
            rtcCallbacks={{
                EndCall: () => {
                    socketRef.current?.emit('end_call', { to: CALLEE_ID, from: MY_USER_ID });
                    cleanupCall();
                },
            }}
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, padding: 20 }}>
      <Text style={styles.title}>Doctor — Awaiting calls</Text>

      {incomingCall ? (
        <View style={{ marginTop: 20 }}>
          <Text style={{ fontWeight: '700' }}>Incoming call from {incomingCall.from}</Text>
          <View style={{ flexDirection: 'row', marginTop: 12 }}>
            <Button title="Accept" onPress={acceptCall} />
            <View style={{ width: 12 }} />
            <Button title="Reject" onPress={rejectCall} />
          </View>
        </View>
      ) : (
        <Text style={{ marginTop: 12, color: '#666' }}>Waiting for patient calls...</Text>
      )}

      <View style={{ marginTop: 18 }}>
        <Text style={{ fontWeight: '700' }}>Debug</Text>
        <Text>{`channel: ${channel}`}</Text>
        <Text>{`uid: ${uid}`}</Text>
        <Text style={{ marginTop: 8, color: '#444' }}>{log}</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 18, fontWeight: '600' },
});
