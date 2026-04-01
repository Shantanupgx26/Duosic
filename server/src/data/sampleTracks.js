export const sampleTracks = [
  {
    id: "helix-1",
    title: "Coastal Drive",
    artist: "SoundHelix",
    artwork:
      "https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?auto=format&fit=crop&w=900&q=80",
    streamUrl: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3",
    durationMs: 372000
  },
  {
    id: "helix-2",
    title: "Afterglow Echo",
    artist: "SoundHelix",
    artwork:
      "https://images.unsplash.com/photo-1501612780327-45045538702b?auto=format&fit=crop&w=900&q=80",
    streamUrl: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3",
    durationMs: 356000
  },
  {
    id: "helix-3",
    title: "Midnight Transit",
    artist: "SoundHelix",
    artwork:
      "https://images.unsplash.com/photo-1516280440614-37939bbacd81?auto=format&fit=crop&w=900&q=80",
    streamUrl: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3",
    durationMs: 407000
  }
];

export const trackMap = new Map(sampleTracks.map((track) => [track.id, track]));
