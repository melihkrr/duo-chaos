'use client'

import { useEffect, useState } from 'react'
import { Battle } from '../components/game/Battle'
import { Home } from '../components/game/Home'
import { Lobby } from '../components/game/Lobby'
import { Results } from '../components/game/Results'
import { TopBar } from '../components/game/TopBar'
import { ConfirmDialog } from '../components/ui/ConfirmDialog'
import { ToastStack } from '../components/ui/Toast'
import { useDuoChaos } from '../lib/useDuoChaos'

export default function Page() {
  const game = useDuoChaos()
  const { state, room, progress, chaos, scout, cosmetics, toast } = game
  const [confirmLeave, setConfirmLeave] = useState(false)

  // URL'de oda kodu varsa otomatik katıl. Tarayıcı geri/ileri tuşları için
  // `popstate` de dinlenir; böylece adres çubuğu ile uygulama durumu senkron
  // kalır (ör. geri tuşuyla `/play/CODE` → `/`).
  useEffect(() => {
    const sync = () => {
      const match = window.location.pathname.match(/\/play\/([A-Za-z0-9]+)/)
      if (match?.[1]) void game.joinRoom(match[1])
    }
    sync()
    window.addEventListener('popstate', sync)
    return () => window.removeEventListener('popstate', sync)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const isHost = room.playerId === 'p1'

  const handleLeave = () => {
    setConfirmLeave(false)
    void game.leaveGame()
  }

  return (
    <main className="game-shell">
      <TopBar
        code={room.code}
        status={room.status}
        online={progress.online}
        onLeave={() => setConfirmLeave(true)}
      />

      {state.phase === 'home' && (
        <Home
          progress={progress}
          onCreate={(name) => void game.createRoom(name)}
          onJoin={(code, name) => void game.joinRoom(code, name)}
          busy={game.busy}
          error={game.error}
          initialName={room.name}
        />
      )}

      {state.phase === 'lobby' && room.code && (
        <Lobby
          code={room.code}
          players={state.players}
          isHost={isHost}
          opponentPresent={room.opponentPresent}
          ready={game.lobbyReady}
          onCopy={() => void game.copyInvite()}
          onStart={() => void game.startGame()}
          onRename={game.setName}
          busy={game.busy}
          error={game.error}
        />
      )}

      {(state.phase === 'countdown' || state.phase === 'battle') && (
        <Battle
          state={state}
          chaos={chaos}
          scout={scout}
          cosmetics={cosmetics}
          level={progress.profile.level}
          secondsLeft={game.secondsLeft}
          onJoystick={() => {
            /* joystick girdisi useGameLoop içindeki klavye ile birleşir */
          }}
          onEmote={game.triggerEmote}
        />
      )}

      {(state.phase === 'results' || state.phase === 'matchover') && (
        <Results
          state={state}
          progress={progress}
          isHost={isHost}
          onNextRound={() => void game.startNextRound()}
          onRematch={() => void game.rematch()}
          busy={game.busy}
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
