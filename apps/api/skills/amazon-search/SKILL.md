---
name: amazon-search
description: Search for products on Amazon.com and get prices, links, and images.
compatibility: opencode
clawbuddy:
  displayName: Amazon Search
  version: 1.2.0
  icon: ShoppingCart
  category: search
  type: python
  networkAccess: true
  installation: pip3 install httpx parsel
  tools:
    - name: amazon_search
      description: Search for products on Amazon.com. Returns a JSON array of products
        with name, price, url, and image.
      script: >-
        import sys, json, os, httpx

        from urllib.parse import urljoin

        from parsel import Selector


        try:
            query = sys.argv[1] if len(sys.argv) > 1 else ''
            url = f'https://www.amazon.com/s?k={query}&page=1'
            headers = {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate, br',
                'DNT': '1',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'Cache-Control': 'max-age=0',
            }
            cookies = {'lc-acbus': 'en_US', 'i18n-prefs': 'USD'}
            proxy = os.environ.get('PROXY_URL') or None
            with httpx.Client(follow_redirects=True, timeout=30.0, headers=headers, proxy=proxy) as client:
                r = client.get(url, cookies=cookies)
                r.raise_for_status()
            sel = Selector(text=r.text)
            products = []
            for box in sel.css('div.s-result-item[data-component-type=s-search-result]'):
                link = box.css('div>a::attr(href)').get()
                product_url = urljoin(str(r.url), link).split('?')[0] if link else None
                if not product_url or '/slredirect/' in product_url:
                    continue
                price = box.css('.a-price[data-a-size=xl] .a-offscreen::text').get()
                if not price:
                    price = box.xpath("//div[@data-cy='secondary-offer-recipe']//span[contains(@class, 'a-color-base') and contains(text(), '$')]/text()").get()
                if not price:
                    continue
                try:
                    price_val = float(price.replace('$', '').replace(',', '').strip())
                except (ValueError, AttributeError):
                    continue
                image = box.css('img.s-image::attr(src)').get()
                name = box.css('div>a>h2::attr(aria-label)').get()
                if not name or 'Sponsored Ad' in name:
                    continue
                products.append({'name': name.strip(), 'price': price_val, 'url': product_url, 'image': image})
            if products:
                def fmt(p):
                    pv = p['price']
                    if pv >= 1000:
                        nice = f'${pv/1000:.1f}K'
                    else:
                        nice = f'${pv:.2f}'
                    return f"- {p['name']}\n  Price: {nice} USD | Link: {p['url']}\n  Image: {p['image'] or 'N/A'}"
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

You can search for products on Amazon using the amazon_search tool. Pass a search query (e.g. 'rtx 3090', 'iphone 15'). Use this when the user asks about product prices, availability, or comparisons on Amazon. When presenting results, always format each product as a markdown link using [Product Name](url) and show the price next to it.
