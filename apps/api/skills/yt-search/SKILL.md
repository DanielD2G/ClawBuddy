---
name: yt-search
description: Search for videos on YouTube and get titles, links, channels,
  durations, and thumbnails.
compatibility: opencode
clawbuddy:
  displayName: YouTube Search
  version: 1.0.0
  icon: Youtube
  category: search
  type: python
  networkAccess: true
  installation: pip3 install yt-dlp
  tools:
    - name: yt_search
      description: Search for videos on YouTube. Returns a list of videos with title,
        URL, channel, duration, view count, and thumbnail.
      script: >-
        import sys, json

        import yt_dlp


        try:
            query = sys.argv[1] if len(sys.argv) > 1 else ''
            max_results = int(sys.argv[2]) if len(sys.argv) > 2 else 5
            max_results = max(1, min(max_results, 10))

            ydl_opts = {
                'quiet': True,
                'no_warnings': True,
                'extract_flat': True,
                'skip_download': True,
            }

            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                result = ydl.extract_info(f'ytsearch{max_results}:{query}', download=False)

            entries = result.get('entries', []) if result else []
            if not entries:
                print(f'No videos found for "{query}"')
                sys.exit(0)

            videos = []
            for e in entries:
                vid_id = e.get('id', '')
                title = e.get('title', 'Unknown')
                channel = e.get('channel') or e.get('uploader') or 'Unknown'
                duration = e.get('duration')
                view_count = e.get('view_count')
                thumbnail = e.get('thumbnails', [{}])[-1].get('url') if e.get('thumbnails') else None
                if not thumbnail:
                    thumbnail = e.get('thumbnail')

                dur_str = ''
                if duration:
                    mins, secs = divmod(int(duration), 60)
                    hours, mins = divmod(mins, 60)
                    dur_str = f'{hours}:{mins:02d}:{secs:02d}' if hours else f'{mins}:{secs:02d}'

                views_str = ''
                if view_count:
                    if view_count >= 1_000_000:
                        views_str = f'{view_count/1_000_000:.1f}M views'
                    elif view_count >= 1_000:
                        views_str = f'{view_count/1_000:.1f}K views'
                    else:
                        views_str = f'{view_count} views'

                videos.append({
                    'title': title,
                    'videoId': vid_id,
                    'url': f'https://www.youtube.com/watch?v={vid_id}',
                    'channel': channel,
                    'duration': dur_str,
                    'views': views_str,
                    'thumbnail': thumbnail,
                })

            lines = [f'Found {len(videos)} videos for "{query}":', '']
            for v in videos:
                meta = ' | '.join(filter(None, [v['channel'], v['duration'], v['views']]))
                lines.append(f"- {v['title']}")
                lines.append(f"  {meta}")
                lines.append(f"  URL: {v['url']}")
                if v['thumbnail']:
                    lines.append(f"  Thumbnail: {v['thumbnail']}")
                lines.append('')
            print('\n'.join(lines))

        except Exception as e:
            print(json.dumps({'error': str(e)}))
            sys.exit(1)
      parameters:
        type: object
        properties:
          query:
            type: string
            description: The YouTube search query, e.g. 'python tutorial', 'lofi hip hop',
              'react hooks explained'
          max_results:
            type: number
            description: Number of results to return (1-10, default 5)
        required:
          - query
---

You can search for videos on YouTube using the yt_search tool. Pass a search query (e.g. 'python tutorial', 'lofi hip hop'). Use this when the user asks to find, search, or look up YouTube videos. When presenting results, embed each video using:

```rich-youtube
{"url": "https://www.youtube.com/watch?v=VIDEO_ID", "title": "Video Title"}
```

Include the channel name and duration as text context around each embed. Only use URLs returned by the tool — never fabricate video IDs.
