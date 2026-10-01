'use client'

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ChaosEvent, Objective } from './types'

export type Language = 'en' | 'tr'
type Translate = (source: string, values?: Record<string, string | number>) => string

const TRANSLATIONS: Record<string, string> = {
  '✨ 2-player realtime party duel': '✨ 2 oyunculu gerçek zamanlı parti düellosu',
  'Two players. One arena. Grab the coins your mission asks for, steal from your rival, and finish with the highest score. Fast, chaotic, and best played with a friend.':
    'İki oyuncu. Tek arena. Görevinin istediği paraları topla, rakibinden çal ve en yüksek skorla bitir. Hızlı, kaotik ve arkadaşınla daha eğlenceli.',
  'Choose your animal': 'Hayvanını seç',
  'Change your animal': 'Hayvanını değiştir',
  'Your rival sees this avatar in the arena.': 'Rakibin bu avatarı arenada görür.',
  'Choose your animal avatar': 'Hayvan avatarını seç',
  'Unlocks at level {level}': '{level}. seviyede açılır',
  'Your name': 'Adın',
  'e.g. Little Panda': 'ör. Minik Panda',
  'Your display name': 'Görünen adın',
  'Your rival will see this name and animal.': 'Rakibin bu adı ve hayvanı görecek.',
  'Your rival': 'Rakibin',
  'Your rival takes the match.': 'Rakibin maçı kazandı.',
  'Game mode': 'Oyun modu',
  'Play with a Friend': 'Arkadaşınla oyna',
  'Play vs Bot': 'Bota karşı oyna',
  'Creating…': 'Oluşturuluyor…',
  '🎉 Create a game': '🎉 Oyun oluştur',
  '🔗 Join with code': '🔗 Kodla katıl',
  'Starting…': 'Başlatılıyor…',
  'Single-player match against a medium-difficulty bot. Same rules, same arena.':
    'Orta zorlukta bir bota karşı tek oyunculu maç. Aynı kurallar, aynı arena.',
  'Pick a name (at least 2 characters) to start.': 'Başlamak için en az 2 karakterli bir ad seç.',
  'Your profile': 'Profilin',
  Bot: 'Bot',
  Level: 'Seviye',
  'XP progress': 'XP ilerlemesi',
  'Create a room': 'Oda oluştur',
  'One tap and your private arena is ready.': 'Tek dokunuşla özel arenan hazır.',
  'Send the link': 'Bağlantıyı gönder',
  'Your rival joins from any device instantly.': 'Rakibin herhangi bir cihazdan anında katılır.',
  'Chase the mission': 'Görevi tamamla',
  'Grab the right coins before they do.': 'Doğru paraları ondan önce topla.',
  'Score the most': 'En yüksek skoru yap',
  'Highest score after 3 rounds wins.': '3 turun sonunda en yüksek skor kazanır.',
  Lobby: 'Lobi',
  'Copy invite': 'Davet bağlantısını kopyala',
  'Edit your name': 'Adını düzenle',
  Player: 'Oyuncu',
  'Waiting…': 'Bekleniyor…',
  You: 'Sen',
  Rival: 'Rakip',
  'Start match': 'Maçı başlat',
  'Waiting for rival…': 'Rakip bekleniyor…',
  'Waiting for the host to start…': 'Oda sahibinin başlatması bekleniyor…',
  'Join a game': 'Oyuna katıl',
  'Enter the 6-character code your friend shared.': 'Arkadaşının paylaştığı 6 karakterli kodu gir.',
  Cancel: 'İptal',
  'Joining…': 'Katılınıyor…',
  '🔗 Join game': '🔗 Oyuna katıl',
  'Room code': 'Oda kodu',
  'Codes are 6 characters (letters/numbers, e.g. ABC234). Letters I, O and digits 0, 1 are not used.':
    'Kodlar 6 karakterden oluşur (harf/rakam, ör. ABC234). I, O harfleri ile 0, 1 rakamları kullanılmaz.',
  'Room {code}': 'Oda {code}',
  Mute: 'Sesi kapat',
  Unmute: 'Sesi aç',
  English: 'İngilizce',
  Turkish: 'Türkçe',
  'Select language': 'Dil seç',
  Leave: 'Ayrıl',
  'Leave this game?': 'Bu oyundan ayrılmak istiyor musun?',
  "You'll return to the home screen.": 'Ana ekrana döneceksin.',
  'Your bot match will be abandoned.': 'Bot maçın sonlandırılacak.',
  'Leave game': 'Oyundan ayrıl',
  Stay: 'Kal',
  'Your rival will be notified.': 'Rakibine haber verilecek.',
  'As the host, leaving will end the room for both players.': 'Oda sahibi olarak ayrılırsan oda iki oyuncu için de sona erer.',
  'You can rejoin later with the same invite link.': 'Aynı davet bağlantısıyla daha sonra tekrar katılabilirsin.',
  'Match over': 'Maç sona erdi',
  'Round {round} results': '{round}. tur sonuçları',
  'You win the match!': 'Maçı kazandın!',
  'Match complete': 'Maç tamamlandı',
  'Next round starting soon': 'Yeni tur birazdan başlıyor',
  'Victory!': 'Zafer!',
  'Good game!': 'Güzel oyundu!',
  Score: 'Skor',
  'Round stats': 'Tur istatistikleri',
  'Coins collected': 'Toplanan para',
  'Coins stolen': 'Çalınan para',
  'Missions completed': 'Tamamlanan görev',
  '✅ Rematch — waiting for rival': '✅ Rövanş — rakip bekleniyor',
  Rematch: 'Rövanş',
  'Both ready — starting a new match…': 'İkiniz de hazırsınız — yeni maç başlıyor…',
  'Waiting for your rival to accept…': 'Rakibinin onayı bekleniyor…',
  'Your rival wants a rematch. Your turn!': 'Rakibin rövanş istiyor. Sıra sende!',
  'Both players must accept to start a rematch.': 'Rövanş için iki oyuncunun da onay vermesi gerekir.',
  '✅ Ready — waiting for rival': '✅ Hazır — rakip bekleniyor',
  'Ready for next round': 'Yeni tur için hazır ol',
  'Both ready — starting…': 'İkiniz de hazırsınız — başlıyor…',
  'Your rival is ready. Your turn!': 'Rakibin hazır. Sıra sende!',
  'Both players must accept to start the next round.': 'Yeni turun başlaması için iki oyuncu da onay vermeli.',
  'Total score': 'Toplam skor',
  'Mission progress': 'Görev ilerlemesi',
  'Round {round}': '{round}. tur',
  'Exit fullscreen': 'Tam ekrandan çık',
  Fullscreen: 'Tam ekran',
  '⤡ Exit': '⤡ Çık',
  '⛶ Fullscreen': '⛶ Tam ekran',
  COMBO: 'KOMBO',
  'Get ready!': 'Hazır ol!',
  'Mission complete!': 'Görev tamamlandı!',
  'You win!': 'Kazandın!',
  'Next time': 'Bir dahaki sefere',
  'Your rival left the game': 'Rakibin oyundan ayrıldı',
  '{rival} left the match — you win. You can stay here and wait for a rematch, or leave the room.':
    '{rival} maçtan ayrıldı — kazandın. Burada kalıp rövanş bekleyebilir veya odadan ayrılabilirsin.',
  '{rival} left the match. Better luck next time — you can stay for a rematch, or leave the room.':
    '{rival} maçtan ayrıldı. Bir dahaki sefere şansını dene — rövanş için kalabilir veya odadan ayrılabilirsin.',
  '{rival} disconnected. The match is paused — you can wait for them to come back, or leave the room.':
    '{rival} bağlantısı kesildi. Maç duraklatıldı — geri dönmesini bekleyebilir veya odadan ayrılabilirsin.',
  '🚪 Leave room': '🚪 Odadan ayrıl',
  Emote: 'Tepki',
  Trail: 'İz',
  'Emote cooldown…': 'Tepki bekleme süresi…',
  Wave: 'El salla',
  Taunt: 'Takıl',
  Shock: 'Şaşır',
  'Good Game': 'Güzel oyun',
  'On Fire': 'Alev aldı',
  None: 'Yok',
  Spark: 'Kıvılcım',
  Frost: 'Ayaz',
  Ember: 'Kor',
  Shadow: 'Gölge',
  Rabbit: 'Tavşan',
  Bear: 'Ayı',
  Fox: 'Tilki',
  Panda: 'Panda',
  Cat: 'Kedi',
  Dog: 'Köpek',
  Frog: 'Kurbağa',
  Penguin: 'Penguen',
  Koala: 'Koala',
  Tiger: 'Kaplan',
  Unicorn: 'Tek boynuzlu at',
  Dragon: 'Ejderha',
  'Gold Rush': 'Altına Hücum',
  'Gold spawns are boosted for 15s.': '15 saniye boyunca daha fazla altın çıkar.',
  'Gold reward x3': 'Altın ödülü x3',
  Blackout: 'Karartma',
  'The arena dims and nearby resources become more valuable.': 'Arena kararır, yakındaki kaynaklar daha değerli olur.',
  'Risky visibility': 'Riskli görüş',
  'Magnet Storm': 'Mıknatıs Fırtınası',
  'Coins drift toward the center and pressure rises.': 'Paralar merkeze doğru sürüklenir, baskı artar.',
  'Resource control': 'Kaynak kontrolü',
  'Chaos Swap': 'Kaos Takası',
  'One of your targets is swapped mid-round.': 'Hedeflerinden biri tur ortasında değişir.',
  'Plans break': 'Planlar değişir',
  Jackpot: 'Büyük İkramiye',
  'A single Diamond appears. First player gets +50.': 'Tek bir Elmas çıkar. İlk alan +50 kazanır.',
  'Diamond +50': 'Elmas +50',
  'Invite link copied to clipboard.': 'Davet bağlantısı panoya kopyalandı.',
  'Copy this link: {url}': 'Bu bağlantıyı kopyala: {url}',
  'Single-player mode — no invite needed.': 'Tek oyunculu mod — davete gerek yok.',
  'Dismiss': 'Kapat',
  'Close dialog': 'Pencereyi kapat',
  Confirm: 'Onayla',
  'Working…': 'İşleniyor…',
  'Connection lost. Check your internet and try again.': 'Bağlantı kesildi. İnternetini kontrol edip tekrar dene.',
  'We could not reach the game server. Check your internet connection and try again.':
    'Oyun sunucusuna ulaşılamadı. İnternet bağlantını kontrol edip tekrar dene.',
  'The server took too long to respond. Please try again.': 'Sunucu yanıt vermekte gecikti. Lütfen tekrar dene.',
  'The game server is updating. Please refresh the page and try again.':
    'Oyun sunucusu güncelleniyor. Sayfayı yenileyip tekrar dene.',
  'You do not have permission to do that. Please refresh the page and try again.':
    'Bu işlem için yetkin yok. Sayfayı yenileyip tekrar dene.',
  'Something went wrong. Please try again.': 'Bir şeyler yanlış gitti. Lütfen tekrar dene.',
  'We could not create the game. Please try again.': 'Oyun oluşturulamadı. Lütfen tekrar dene.',
  'We could not join that game. Please try again.': 'Oyuna katılınamadı. Lütfen tekrar dene.',
  'We could not start the match. Please try again.': 'Maç başlatılamadı. Lütfen tekrar dene.',
  'This room already has two players. Ask your friend to leave, or create a new game.':
    'Bu odada zaten iki oyuncu var. Arkadaşından ayrılmasını iste veya yeni oyun oluştur.',
  'We could not find that room. Check the code and try again.': 'Bu oda bulunamadı. Kodu kontrol edip tekrar dene.',
  'A room with that code already exists. Please try creating a new game.':
    'Bu kodla bir oda zaten var. Lütfen yeni oyun oluşturmayı dene.',
  'That room code looks wrong. Codes are 6 letters/numbers (e.g. ABC123).':
    'Oda kodu hatalı görünüyor. Kodlar 6 harf/rakamdan oluşur (ör. ABC123).',
  'You are not part of this room anymore. Please rejoin with the invite link.':
    'Artık bu odanın üyesi değilsin. Davet bağlantısıyla tekrar katıl.',
  'Only the host can start the match.': 'Maçı yalnızca oda sahibi başlatabilir.',
  'Your rival is still connecting — try again in a moment.': 'Rakibin hâlâ bağlanıyor — birazdan tekrar dene.',
  'This match has already started.': 'Bu maç zaten başladı.',
  'Rookie': 'Çaylak',
  'Chaos Master': 'Kaos Ustası',
  'Risk Taker': 'Risk Avcısı',
  'Coin Thief': 'Para Hırsızı',
  'Chaos Rookie': 'Kaos Çaylağı',
}

const DYNAMIC_LABELS: Record<string, string> = {
  gold: 'Altın',
  blue: 'Mavi',
  red: 'Kırmızı',
  emerald: 'Zümrüt',
  diamond: 'Elmas',
}

const interpolate = (value: string, values?: Record<string, string | number>) =>
  values
    ? value.replace(/\{(\w+)\}/g, (match, key: string) =>
        Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match,
      )
    : value

export const translateForLanguage = (
  source: string,
  language: Language,
  values?: Record<string, string | number>,
) => {
  const translated = language === 'tr' ? TRANSLATIONS[source] ?? source : source
  return interpolate(translated, values)
}

type I18nValue = { language: Language; setLanguage: (language: Language) => void; t: Translate }
const I18nContext = createContext<I18nValue>({
  language: 'en',
  setLanguage: () => undefined,
  t: (source, values) => interpolate(source, values),
})

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>('en')

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const saved = window.localStorage.getItem('duo-chaos:language')
      if (saved === 'en' || saved === 'tr') setLanguageState(saved)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [])

  const setLanguage = (next: Language) => {
    setLanguageState(next)
    window.localStorage.setItem('duo-chaos:language', next)
  }

  useEffect(() => {
    document.documentElement.lang = language
    document.title =
      language === 'tr'
        ? 'DUO CHAOS — Gör. Çal. Kazan.'
        : 'DUO CHAOS — See it. Steal it. Win it.'
  }, [language])

  const value = useMemo<I18nValue>(
    () => ({
      language,
      setLanguage,
      t: (source, values) => translateForLanguage(source, language, values),
    }),
    [language],
  )

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export const useI18n = () => useContext(I18nContext)

export const localizedObjectiveLabel = (objective: Objective | null | undefined, language: Language) => {
  if (!objective) return language === 'tr' ? '3 Altın Topla' : 'Collect 3 Gold'
  const labels: Record<string, [string, string]> = {
    'gold-rush': ['Collect 3 Gold', '3 Altın Topla'],
    'blue-raid': ['Collect 2 Blue + 2 Red', '2 Mavi + 2 Kırmızı Topla'],
    'emerald-hunt': ['Collect 3 Emerald', '3 Zümrüt Topla'],
    'resource-control': ['Steal 3 from your rival', 'Rakibinden 3 Para Çal'],
    'jackpot-run': ['Collect 1 Gold + 2 Blue', '1 Altın + 2 Mavi Topla'],
    'red-burn': ['Collect 2 Red + 1 Emerald', '2 Kırmızı + 1 Zümrüt Topla'],
    'blue-pressure': ['Collect 4 Blue', '4 Mavi Topla'],
    'gold-robbery': ['Steal 2 and secure 1 Gold', '2 Para Çal ve 1 Altın Topla'],
  }
  return labels[objective.id]?.[language === 'tr' ? 1 : 0] ?? objective.label
}

export const localizedChaosEvent = (event: ChaosEvent, language: Language): ChaosEvent => {
  if (language === 'en') return event
  return {
    ...event,
    name: TRANSLATIONS[event.name] ?? event.name,
    description: TRANSLATIONS[event.description] ?? event.description,
    boost: TRANSLATIONS[event.boost] ?? event.boost,
  }
}

export const localizedText = (source: string, language: Language) =>
  language === 'tr'
    ? source.startsWith('Copy this link: ')
      ? `Bu bağlantıyı kopyala: ${source.slice('Copy this link: '.length)}`
      : TRANSLATIONS[source] ?? source
    : source

export const coinTypeLabel = (type: string, language: Language) =>
  language === 'tr' ? DYNAMIC_LABELS[type] ?? type : type
