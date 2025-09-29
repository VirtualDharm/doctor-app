// doctor-app/App.js
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Button, StyleSheet } from 'react-native';
import AgoraUIKit from 'agora-rn-uikit';
import { io } from 'socket.io-client';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { Audio } from 'expo-av';
import { NavigationContainer } from '@react-navigation/native';
import { SafeAreaView } from 'react-native-safe-area-context';

// ---- Agora / server config ----
const APP_ID = '60bdf4f5f1b641f583d20d28d7a923d1';
const SIGNALING_SERVER = 'https://server-w411.onrender.com';
const MY_USER_ID = 'doctor';

// ---- Linking config (for deep links, optional) ----
const linking = {
  prefixes: ['doctorapp://'],
  config: {
    screens: {
      IncomingCall: 'incoming/:channel/:from',
    },
  },
};

// ---- Foreground notification behavior ----
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

export default function App() {
  const socketRef = useRef(null);
  const [incomingCall, setIncomingCall] = useState(null);
  const [joined, setJoined] = useState(false);
  const [token, setToken] = useState(null);
  const [uid, setUid] = useState(null);
  const [channel, setChannel] = useState('');
  const [log, setLog] = useState('');
  const ringingSound = useRef(null);
  const [expoPushToken, setExpoPushToken] = useState('');

  // ---- Setup sockets & push registration ----
  useEffect(() => {
    const socket = io(SIGNALING_SERVER, { transports: ['websocket'] });
    socketRef.current = socket;

    socket.on('connect', async () => {
      socket.emit('register', { userId: MY_USER_ID });
      appendLog('registered to signaling server');

      const token = await registerForPushNotificationsAsync();
      if (token) {
        setExpoPushToken(token);
        console.log('📲 Expo Push Token:', token);
        socketRef.current.emit('register_push', { userId: MY_USER_ID, pushToken: token });
      } else {
        console.log('No push token retrieved');
      }
    });

    socket.on('incoming_call', async (payload) => {
      appendLog('incoming call from ' + payload.from);
      setIncomingCall(payload);
      await playRingtone();
    });

    socket.on('call_rejected', () => {
      appendLog('caller rejected or canceled');
      stopRingtone();
    });

    socket.on('end_call', () => {
      appendLog('peer ended the call');
      cleanupCall();
      stopRingtone();
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  // ---- Notification listeners (3 layers) ----
  useEffect(() => {
    // Foreground notifications
    const receivedSub = Notifications.addNotificationReceivedListener((notification) => {
      console.log('📩 Notification received (foreground):', notification.request.content.data);
      appendLog('notification received (foreground)');
    });

    // Background app tapped
    const responseSub = Notifications.addNotificationResponseReceivedListener((response) => {
      console.log('👆 Notification tapped (background):', response.notification.request.content.data);
      appendLog('notification tapped (background), restoring call state');

      const data = response.notification.request.content.data;
      if (data.type === 'incoming_call') {
        setIncomingCall({
          from: data.from,
          channel: data.channel,
          patientId: data.patientId,
          name: data.name,
          symptoms: data.symptoms,
        });
        playRingtone();
      }
    });

    // Cold start (killed app tapped)
    (async () => {
      const lastResponse = await Notifications.getLastNotificationResponseAsync();
      if (lastResponse) {
        console.log('🚀 Cold start from notification:', lastResponse.notification.request.content.data);
        appendLog('cold start notification, restoring call state');
        const data = lastResponse.notification.request.content.data;
        if (data.type === 'incoming_call') {
          setIncomingCall({
            from: data.from,
            channel: data.channel,
            patientId: data.patientId,
            name: data.name,
            symptoms: data.symptoms,
          });
          playRingtone();
        }
      }
    })();

    return () => {
      receivedSub.remove();
      responseSub.remove();
    };
  }, []);

  // ---- Push registration ----
  async function registerForPushNotificationsAsync() {
    if (!Device.isDevice) {
      console.log('Must use physical device for push notifications');
      return null;
    }

    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;

    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }

    if (finalStatus !== 'granted') {
      console.log('Push notification permissions not granted');
      return null;
    }

    try {
      const projectId =
        Constants?.expoConfig?.extra?.eas?.projectId ?? Constants?.easConfig?.projectId;
      const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
      return token;
    } catch (err) {
      console.error('Error getting Expo push token:', err);
      return null;
    }
  }

  // ---- Sound helpers ----
  async function playRingtone() {
    try {
      if (ringingSound.current) return;
      const { sound } = await Audio.Sound.createAsync(
        require('./assets/ringtone.mp3'),
        { shouldPlay: true, isLooping: true }
      );
      ringingSound.current = sound;
      await sound.playAsync();
    } catch (err) {
      console.error('ringtone play error', err);
    }
  }

  async function stopRingtone() {
    try {
      if (ringingSound.current) {
        await ringingSound.current.stopAsync();
        await ringingSound.current.unloadAsync();
        ringingSound.current = null;
      }
    } catch (err) {
      console.error('ringtone stop error', err);
    }
  }

  // ---- Call helpers ----
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

      stopRingtone();
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
    stopRingtone();
    setIncomingCall(null);
  }

  // ---- Render ----
  if (joined) {
    return (
      <SafeAreaView style={{ flex: 1 }}>
        <AgoraUIKit
          connectionData={{ appId: APP_ID, channel, token, uid }}
          settings={{}}
          rtcCallbacks={{
            EndCall: () => {
              socketRef.current?.emit('end_call', { to: 'patient', from: MY_USER_ID });
              cleanupCall();
              stopRingtone();
            },
          }}
        />
      </SafeAreaView>
    );
  }

  return (
    <NavigationContainer linking={linking}>
      <SafeAreaView style={{ flex: 1, padding: 20 }}>
        <Text style={styles.title}>Doctor — Awaiting calls</Text>

        {incomingCall ? (
          <View style={{ marginTop: 20 }}>
            <Text style={{ fontWeight: '700' }}>Incoming call from {incomingCall.from}</Text>
            <Text style={{ marginTop: 8 }}>Patient: {incomingCall.name}</Text>
            <Text>Symptoms: {incomingCall.symptoms}</Text>
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
          <Text>{`expoPushToken: ${expoPushToken}`}</Text>
          <Text style={{ marginTop: 8, color: '#444' }}>{log}</Text>
        </View>
      </SafeAreaView>
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 18, fontWeight: '600' },
});
