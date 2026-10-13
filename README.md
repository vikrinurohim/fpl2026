# FPL 2026 — QA Nippon Paint

Dashboard liga FPL [1331564](https://fantasy.premierleague.com/en/leagues/1331564/standings/c).

## Pembaruan otomatis

Workflow `.github/workflows/update-fpl.yml` memeriksa API FPL setiap jam pada menit 17 UTC (menit 17 setiap jam WIB juga). Jadwal GitHub bisa terlambat. Gameweek hanya diperbarui jika **`finished === true` dan `data_checked === true`**; menjalankan manual tetap memakai syarat yang sama.

Data diperbarui langsung dalam `index.html`: klasemen, total poin, grafik, chip, hit, bench, line-up, total slot XI, pilihan klub/pemain, dan rincian transfer. Poin GW memakai skor resmi sebelum hit; total kumulatif memakai skor resmi setelah hit. Pilihan klub menghitung XI saat deadline, tanpa menambah slot autosub. Data lama dipertahankan; gameweek yang terlewat disusulkan. GW final terbaru diperiksa ulang untuk koreksi. Pembaruan gagal jika data pemain tidak lengkap atau jumlah poin berbeda dari skor resmi; web sebelumnya tetap tersedia.

Anggota liga dibaca otomatis, termasuk halaman berikutnya. `entryStartEvents` dalam `fpl.config.json` mempertahankan Milenials mulai GW2. Untuk anggota baru, awal musim mengikuti `started_event` FPL dan awal liga. Nama manager/tim harus unik karena dashboard menyimpan sebagian data berdasarkan nama. Perubahan musim dihentikan oleh `seasonStartYear` agar riwayat musim ini tidak tertimpa.

## Mengaktifkan di GitHub

1. Masukkan perubahan ini ke branch `main` repository `vikrinurohim/fpl2026`.
2. Buka **Settings → Pages → Build and deployment → Source → GitHub Actions**.
3. Pastikan GitHub Actions diizinkan dan aturan branch mengizinkan `github-actions[bot]` menyimpan pembaruan di `main`.
4. Buka **Actions → Update finalized FPL data and website → Run workflow** untuk penerbitan pertama.

Workflow memakai `GITHUB_TOKEN` bawaan; tidak memerlukan token FPL atau secret tambahan. Data di-commit hanya ketika berubah, kemudian diterbitkan melalui `actions/deploy-pages` pada workflow yang sama. Ini diperlukan karena commit dengan `GITHUB_TOKEN` tidak memicu build Pages berbasis branch. Lokasi web: `https://vikrinurohim.github.io/fpl2026/` setelah Pages diaktifkan.

## Pemeriksaan lokal

Memerlukan Node.js 22:

```sh
node --test scripts/update-fpl.test.mjs
node scripts/update-fpl.mjs
```

Tes mencakup kedua flag ketat, data belum final, perhitungan hit/kapten/autosub, GW terlewat, pagination, data gagal, pergantian musim, dan pembaruan berulang tanpa perubahan.
