(() => {
  const year = document.getElementById('year');
  if (year) year.textContent = String(new Date().getFullYear());

  // 全站动效总开关：GSAP 缺位或用户偏好减少动效时，一律回落为无动画的瞬时切换
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const canAnimate = () => typeof gsap !== 'undefined' && !reduceMotion.matches;

  // Mobile nav（GSAP 开合；窄屏媒体查询之外不播动画，避免污染桌面静态布局）
  const toggle = document.getElementById('nav-toggle');
  const links = document.getElementById('nav-links');
  if (toggle && links) {
    const mobileNav = window.matchMedia('(max-width: 720px)');
    let navOpen = false;
    let navTween = null;

    // 中断进行中的开/合动画并清掉内联样式，防止残留样式污染下一次切换或桌面布局
    const settleNav = () => {
      if (navTween) {
        navTween.kill();
        gsap.set(links, { clearProps: 'all' });
        navTween = null;
      }
    };

    const setOpen = (open) => {
      if (open === navOpen) return;
      navOpen = open;
      settleNav();
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', open ? '关闭菜单' : '打开菜单');
      const icon = toggle.querySelector('use');
      if (icon) icon.setAttribute('href', open ? '#i-x' : '#i-menu');
      if (open) {
        links.classList.add('open');
        if (canAnimate() && mobileNav.matches) {
          navTween = gsap.from(links, { y: -8, autoAlpha: 0, duration: .2, ease: 'power3.out', clearProps: 'all', overwrite: true });
        }
      } else if (canAnimate() && mobileNav.matches) {
        // 先收起再摘 .open（display 隐藏），收起完成后清内联样式并 kill 退役，防止残余重绘
        navTween = gsap.to(links, { y: -8, autoAlpha: 0, duration: .18, ease: 'power2.in', onComplete: () => {
          const retired = navTween;
          navTween = null;
          links.classList.remove('open');
          gsap.set(links, { clearProps: 'all' });
          if (retired) retired.kill();
        } });
      } else {
        links.classList.remove('open');
      }
    };

    toggle.addEventListener('click', () => {
      setOpen(!navOpen);
    });

    links.querySelectorAll('a').forEach((a) => {
      a.addEventListener('click', () => setOpen(false));
    });

    window.addEventListener('resize', () => {
      if (window.innerWidth > 720) setOpen(false);
    });
  }

  // FAQ 手风琴：拦截 details 原生瞬时开合，用 GSAP 补高度过渡；动画中途再点可平滑掉头
  document.querySelectorAll('.faq-item').forEach((item) => {
    const summary = item.querySelector('summary');
    const body = item.querySelector('.faq-body');
    if (!summary || !body) return;
    const padBottom = getComputedStyle(body).paddingBottom;
    let anim = null;
    // immediateRender:false —— 创建时不套起始态，避免污染减少动效模式下的原生开合；
    // 每次完全收起后 kill() 退役并在下次展开时重建，杜绝完成后仍被时钟重绘出残留样式
    const createAnim = () => canAnimate() ? gsap.fromTo(
      body,
      { height: 0, paddingBottom: 0, autoAlpha: 0, overflow: 'hidden' },
      {
        height: 'auto',
        paddingBottom: padBottom,
        autoAlpha: 1,
        duration: .24,
        ease: 'power2.inOut',
        paused: true,
        immediateRender: false,
        clearProps: 'all',
        onComplete: () => gsap.set(body, { clearProps: 'all' }),
        onReverseComplete: () => {
          item.open = false;
          gsap.set(body, { clearProps: 'all' });
          if (anim) { const retired = anim; anim = null; retired.kill(); }
        },
      },
    ) : null;
    anim = canAnimate() ? createAnim() : null;
    summary.addEventListener('click', (e) => {
      e.preventDefault();
      if (reduceMotion.matches) {
        item.open = !item.open;
        return;
      }
      // 关 → 开：退役过的 tween 在此重建
      if (!item.open) {
        item.open = true;
        if (!anim) anim = createAnim();
        if (anim) anim.play();
        return;
      }
      // 开 → 关；关合中途再点（reversed=true）= 掉头继续展开
      if (!anim) {
        item.open = false;
        return;
      }
      if (anim.isActive() && anim.reversed()) anim.play();
      else anim.reverse();
    });
  });

  // Scroll reveal
  const reveals = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('visible');
            io.unobserve(entry.target);
          }
        });
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.12 }
    );
    reveals.forEach((el) => io.observe(el));
  } else {
    reveals.forEach((el) => el.classList.add('visible'));
  }

  // Bento spotlight
  document.querySelectorAll('.bcard').forEach((card) => {
    card.addEventListener('pointermove', (e) => {
      const rect = card.getBoundingClientRect();
      card.style.setProperty('--mx', `${e.clientX - rect.left}px`);
      card.style.setProperty('--my', `${e.clientY - rect.top}px`);
    });
  });

  // Lightbox
  const lightbox = document.getElementById('lightbox');
  if (lightbox) {
    const img = lightbox.querySelector('img');
    const closeBtn = lightbox.querySelector('.lightbox-close');
    let lastFocus = null;

    const open = (src, alt) => {
      if (!img) return;
      lastFocus = document.activeElement;
      img.src = src;
      img.alt = alt || '';
      lightbox.hidden = false;
      requestAnimationFrame(() => lightbox.classList.add('open'));
      document.body.style.overflow = 'hidden';
      closeBtn?.focus();
    };

    const close = () => {
      lightbox.classList.remove('open');
      document.body.style.overflow = '';
      window.setTimeout(() => {
        if (!lightbox.classList.contains('open')) {
          lightbox.hidden = true;
          if (img) img.src = '';
        }
      }, 250);
      if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
    };

    document.querySelectorAll('[data-lightbox]').forEach((el) => {
      const src = el.getAttribute('data-lightbox');
      if (!src) return;
      const sourceImg = el.querySelector('img');
      el.addEventListener('click', () => open(src, sourceImg?.alt || ''));
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open(src, sourceImg?.alt || '');
        }
      });
    });

    closeBtn?.addEventListener('click', close);
    lightbox.addEventListener('click', (e) => {
      if (e.target === lightbox) close();
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && lightbox.classList.contains('open')) close();
    });
  }

  // Header shadow on scroll
  const header = document.querySelector('.site-header');
  if (header) {
    const onScroll = () => {
      header.style.boxShadow =
        window.scrollY > 8
          ? '0 8px 28px -18px rgba(30, 25, 15, .25)'
          : 'none';
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }
})();
