---
name: ml-search
description: Search for products on MercadoLibre Argentina and get prices,
  links, and images.
compatibility: opencode
clawbuddy:
  displayName: MercadoLibre Search
  version: 1.2.0
  icon: ShoppingCart
  category: search
  type: python
  networkAccess: true
  installation: pip3 install httpx parsel
  tools:
    - name: ml_search
      description: Search for products on MercadoLibre Argentina. Returns a JSON array
        of products with name, price, url, and image.
      script: >-
        import sys, json, os, httpx

        from parsel import Selector


        try:
            query = sys.argv[1] if len(sys.argv) > 1 else ''
            url = f'https://listado.mercadolibre.com.ar/{query}'
            headers = {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9,es;q=0.8',
            }
            proxy = os.environ.get('PROXY_URL') or None
            with httpx.Client(follow_redirects=True, timeout=30.0, proxy=proxy) as client:
                r = client.get(url, params={'sb': 'all_mercadolibre'}, headers=headers)
                r.raise_for_status()
            sel = Selector(text=r.text)
            products = []
            for item in sel.css('li.ui-search-layout__item'):
                title = item.css('a.poly-component__title::text').get()
                link = item.css('a.poly-component__title::attr(href)').get()
                pf = item.css('div.poly-price__current span.andes-money-amount__fraction::text').get()
                if not pf:
                    pf = item.css('span.andes-money-amount__fraction::text').get()
                pc = item.css('div.poly-price__current span.andes-money-amount__cents::text').get()
                price = None
                if pf:
                    clean = pf.replace('.', '').replace(',', '')
                    price = f'{clean}.{pc}' if pc else clean
                img = item.css('img.poly-component__picture::attr(data-src)').get()
                if not img:
                    src = item.css('img.poly-component__picture::attr(src)').get()
                    if src and not src.startswith('data:'):
                        img = src
                if title and price:
                    clean_link = link.split('#')[0].split('?')[0] if link else None
                    products.append({'name': title.strip(), 'price': price, 'url': clean_link, 'image': img})
            if products:
                def fmt(p):
                    price_num = float(p['price'])
                    if price_num >= 1_000_000:
                        nice = f'${price_num/1_000_000:.2f}M'
                    elif price_num >= 1_000:
                        nice = f'${price_num/1_000:.1f}K'
                    else:
                        nice = f'${price_num:.0f}'
                    return f"- {p['name']}\n  Price: {nice} ARS | Link: {p['url']}\n  Image: {p['image'] or 'N/A'}"
                lines = [f'Found {len(products)} products for "{query}":', '']
                for p in products[:10]:
                    lines.append(fmt(p))
                print('\n'.join(lines))
            else:
                print(f'No products found for "{query}" (status: {r.status_code})')
        except Exception as e:
            print(json.dumps({'error': str(e)}))
            sys.exit(1)
      parameters:
        type: object
        properties:
          query:
            type: string
            description: The product search query, e.g. 'rtx 3090', 'notebook lenovo',
              'iphone 15'
        required:
          - query
  inputs:
    proxy_url:
      type: var
      description: Optional HTTP/SOCKS5 proxy URL for outbound requests (e.g.
        http://user:pass@host:port or socks5://host:port)
      placeholder: http://user:pass@proxy:8080
---

You can search for products on MercadoLibre Argentina using the ml_search tool. Pass a search query (e.g. 'rtx 3090', 'iphone 15'). Use this when the user asks about product prices, availability, or comparisons on MercadoLibre. When presenting results, always format each product as a markdown link using [Product Name](url) and show the price next to it.
