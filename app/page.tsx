'use client'

import { useEffect, useState } from 'react'
import { Battle } from '../components/game/Battle'
import { Home } from '../components/game/Home'
import { Lobby } from '../components/game/Lobby'
import { Results } from '../components/game/Results'
import { TopBar } from '../components/game/TopBar'
import { ConfirmDialog } from '../components/ui/ConfirmDialog'
import { ToastStack } from '../components/ui/Toast'
import { useBotGame } from '../lib/useBotGame'
import { useDuoChaos } from '../lib/useDuoChaos'

export default function Page() {
  const multiplayer = useDuoChaos()
  const bot = useBotGame()
  // Aktif mod: 'multiplayer' (2 oyunculu, sunucu otoriteli) veya 'bot' (tek
  // oyunculu, tamamen yerel). Varsayılan çok oyunculu; kullanıcı "Play vs Bot"
  // seçince tek oyunculuya geçer. Çok oyunculu akış DEĞİŞMEZ.
  const [mode, setMode] = useState<'multiplayer' | 'bot'>('multiplayer')
  const [confirmLeave, setConfirmLeave] = useState(false)

  // URL'de oda kodu varsa otomatik katıl (yalnızca çok oyunculu modda).
  // Tarayıcı geri/ileri tuşları için `popstate` de dinlenir.
  //
  // ÖNEMLİ: Önce `restore` denenir. Bu odaya daha önce katıldıysak kayıtlı
  // token ile YENİDEN BAĞLANIRIZ; aksi halde her girişte yeni token üretilip
  // "room full" hatası alınırdı. Token yoksa/geçersizse normal `joinRoom`
  // akışına düşülür.
  useEffect(() => {
    const sync = () => {
      const match = window.location.pathname.match(/\/play\/([A-Za-z0-9]+)/)
      if (!match?.[1]) return
      const code = match[1]
      // URL'de oda kodu varsa çok oyunculu moda geç.
      setMode('multiplayer')
      void (async () => {
        const restored = await multiplayer.restore(code)
        if (!restored) await multiplayer.joinRoom(code)
      })()
    }
    sync()
    window.addEventListener('popstate', sync)
    return () => window.removeEventListener('popstate', sync)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleLeave = () => {
    setConfirmLeave(false)
    if (mode === 'bot') {
      bot.leaveGame()
      setMode('multiplayer')
    } else {
      void multiplayer.leaveGame()
    }
  }

  // --- TEK OYUNCULU (BOT) MOD ---
  if (mode === 'bot') {
    const { state, chaos, cosmetics, toast, progress } = bot
    return (
      <main className="game-shell">
        <TopBar code={null} showLeave onLeave={() => setConfirmLeave(true)} />

        {state.phase === 'home' && (
          <Home
            progress={progress}
            onCreate={() => undefined}
            onJoin={() => undefined}
            onPlayBot={(name) => bot.startBotGame(name)}
            busy={bot.busy}
            error={bot.error}
            initialName={state.players[0]?.name ?? ''}
          />
        )}

        {(state.phase === 'countdown' || state.phase === 'battle') && (
          <Battle
            state={state}
            chaos={chaos}
            cosmetics={cosmetics}
            level={progress.profile.level}
            secondsLeft={bot.secondsLeft}
            onJoystick={bot.onJoystick}
            livePos={bot.livePos}
            liveRivalPos={bot.liveRivalPos}
            celebrateRef={bot.celebrateRef}
            diamondPopRef={bot.diamondPopRef}
            comboRef={bot.comboRef}
            scorePopRef={bot.scorePopRef}
            shakeRef={bot.shakeRef}
            rivalLeft={false}
            onLeaveRoom={() => setConfirmLeave(true)}
          />
        )}

        {(state.phase === 'results' || state.phase === 'matchover') && (
          <Results
            state={state}
            nextReady={bot.nextReady}
            rivalNextReady={false}
            onApproveNextRound={bot.approveNextRound}
            rematchReady={bot.rematchReady}
            rivalRematchReady={false}
            onRematch={bot.rematch}
            busy={bot.busy}
          />
        )}

        <ConfirmDialog
          open={confirmLeave}
          title="Leave this game?"
          subtitle="You'll return to the home screen."
          confirmLabel="Leave game"
          cancelLabel="Stay"
          danger
          onConfirm={handleLeave}
          onCancel={() => setConfirmLeave(false)}
        >
          <p className="muted">Your bot match will be abandoned.</p>
        </ConfirmDialog>

        <ToastStack toasts={toast.toasts} onDismiss={toast.dismiss} />
      </main>
    )
  }

  // --- ÇOK OYUNCULU MOD (DEĞİŞMEDİ) ---
  const { state, room, progress, chaos, cosmetics, toast } = multiplayer
  const isHost = room.playerId === 'p1'

  return (
    <main className="game-shell">
      <TopBar code={room.code} onLeave={() => setConfirmLeave(true)} />

      {state.phase === 'home' && (
        <Home
          progress={progress}
          onCreate={(name) => void multiplayer.createRoom(name)}
          onJoin={(code, name) => void multiplayer.joinRoom(code, name)}
          onPlayBot={(name) => {
            bot.startBotGame(name)
            setMode('bot')
          }}
          busy={multiplayer.busy}
          error={multiplayer.error}
          initialName={room.name}
        />
      )}

      {state.phase === 'lobby' && room.code && (
        <Lobby
          code={room.code}
          players={state.players}
          isHost={isHost}
          opponentPresent={room.opponentPresent}
          ready={multiplayer.lobbyReady}
          onCopy={() => void multiplayer.copyInvite()}
          onStart={() => void multiplayer.startGame()}
          onRename={multiplayer.setName}
          avatar={progress.progress.avatar}
          level={progress.profile.level}
          onSelectAvatar={multiplayer.setAvatar}
          busy={multiplayer.busy}
          error={multiplayer.error}
        />
      )}

      {(state.phase === 'countdown' || state.phase === 'battle') && (
        <Battle
          state={state}
          chaos={chaos}
          cosmetics={cosmetics}
          level={progress.profile.level}
          secondsLeft={multiplayer.secondsLeft}
          onJoystick={multiplayer.onJoystick}
          livePos={multiplayer.livePos}
          liveRivalPos={multiplayer.liveRivalPos}
          celebrateRef={multiplayer.celebrateRef}
          diamondPopRef={multiplayer.diamondPopRef}
          comboRef={multiplayer.comboRef}
          scorePopRef={multiplayer.scorePopRef}
          shakeRef={multiplayer.shakeRef}
          rivalLeft={multiplayer.rivalLeft}
          onLeaveRoom={() => setConfirmLeave(true)}
        />
      )}

      {(state.phase === 'results' || state.phase === 'matchover') && (
        <Results
          state={state}
          nextReady={multiplayer.nextReady}
          rivalNextReady={multiplayer.rivalNextReady}
          onApproveNextRound={multiplayer.approveNextRound}
          rematchReady={multiplayer.rematchReady}
          rivalRematchReady={multiplayer.rivalRematchReady}
          onRematch={() => void multiplayer.rematch()}
          busy={multiplayer.busy}
        />
      )}

      <ConfirmDialog
        open={confirmLeave}
        title="Leave this game?"
        subtitle="You'll return to the home screen. Your rival will be notified."
        confirmLabel="Leave game"
        cancelLabel="Stay"
        danger
        onConfirm={handleLeave}
        onCancel={() => setConfirmLeave(false)}
      >
        <p className="muted">
          {isHost
            ? 'As the host, leaving will end the room for both players.'
            : 'You can rejoin later with the same invite link.'}
        </p>
      </ConfirmDialog>

      <ToastStack toasts={toast.toasts} onDismiss={toast.dismiss} />
    </main>
  )
}
