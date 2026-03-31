/**
 * CloudPulse AI Landing Page - Interactive & Performant
 * Utilizes IntersectionObserver for GPU-accelerated enter animations.
 */

document.addEventListener('DOMContentLoaded', () => {
    
    // 1. Navbar Scroll Effect
    // Uses passive event listener for better performance
    const navbar = document.getElementById('navbar');
    let isScrolled = false;
    
    // Throttle scroll events for the navbar state to prevent layout thrashing
    const onScroll = () => {
        const scrolledY = window.scrollY > 50;
        if (scrolledY && !isScrolled) {
            navbar.classList.add('scrolled');
            isScrolled = true;
        } else if (!scrolledY && isScrolled) {
            navbar.classList.remove('scrolled');
            isScrolled = false;
        }
    };
    
    window.addEventListener('scroll', onScroll, { passive: true });
    // Initialize state
    onScroll();

    // 2. High-Performance Intersection Observer for Scroll Animations
    // The observe-me class is added to sections/elements we want to animate in.
    const observerOptions = {
        root: null,
        rootMargin: '0px 0px -100px 0px', // Trigger slightly before it fully comes into view
        threshold: 0.1 // 10% of element must be visible
    };

    const entranceObserver = new IntersectionObserver((entries, observer) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                // Add the class that triggers the CSS opacity/transform transition
                entry.target.classList.add('in-view');
                // Unobserve after animating to save performance (only animates once)
                observer.unobserve(entry.target);
            }
        });
    }, observerOptions);

    const animatedElements = document.querySelectorAll('.observe-me');
    animatedElements.forEach(el => entranceObserver.observe(el));

    // 3. Smooth Scrolling for Navigation Links
    const navLinks = document.querySelectorAll('a.nav-link[href^="#"]');
    navLinks.forEach(link => {
        link.addEventListener('click', function(e) {
            e.preventDefault();
            const targetId = this.getAttribute('href');
            if(targetId === '#') return;
            const targetElement = document.querySelector(targetId);
            if(targetElement) {
                targetElement.scrollIntoView({
                    behavior: 'smooth',
                    block: 'start'
                });
            }
        });
    });

    // 4. Mobile Menu Toggle
    const mobileToggle = document.querySelector('.mobile-toggle');
    const navLinksContainer = document.querySelector('.nav-links');
    const navActions = document.querySelector('.nav-actions');

    if(mobileToggle && navLinksContainer) {
        mobileToggle.addEventListener('click', () => {
            // Very simple toggle logic
            if (navLinksContainer.style.display === 'flex') {
                navLinksContainer.style.display = 'none';
                if(navActions) navActions.style.display = 'none';
            } else {
                navLinksContainer.style.display = 'flex';
                navLinksContainer.style.flexDirection = 'column';
                navLinksContainer.style.position = 'absolute';
                navLinksContainer.style.top = '100%';
                navLinksContainer.style.left = '0';
                navLinksContainer.style.width = '100%';
                navLinksContainer.style.background = 'rgba(10, 14, 23, 0.95)';
                navLinksContainer.style.padding = '2rem';
                navLinksContainer.style.backdropFilter = 'blur(10px)';
                
                if(navActions) {
                    navActions.style.display = 'flex';
                    navActions.style.position = 'absolute';
                    navActions.style.top = 'calc(100% + 150px)';
                    navActions.style.left = '0';
                    navActions.style.width = '100%';
                    navActions.style.justifyContent = 'center';
                }
            }
        });
    }

    // 5. FAQ Accordion Logic (High Performance Toggle)
    const faqItems = document.querySelectorAll('.faq-item');
    faqItems.forEach(item => {
        const questionbtn = item.querySelector('.faq-question');
        questionbtn.addEventListener('click', () => {
            const isActive = item.classList.contains('active');
            
            // Close all other items for a cleaner UI
            faqItems.forEach(faq => faq.classList.remove('active'));
            
            // Toggle clicked item
            if (!isActive) {
                item.classList.add('active');
            }
        });
    });

    // 6. Contact Form Logic
    const contactForm = document.querySelector('.contact-form');
    if (contactForm) {
        contactForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const btn = contactForm.querySelector('button');
            const originalText = btn.innerHTML;
            btn.innerHTML = 'Sent! <i class="fa-solid fa-check"></i>';
            btn.style.background = '#10b981'; // Success green
            contactForm.reset();
            
            setTimeout(() => {
                btn.innerHTML = originalText;
                btn.style.background = ''; // Reverts to CSS default
            }, 3000);
        });
    }

    // 7. ROI Calculator Logic
    const spendInput = document.getElementById('aws-spend');
    const spendVal = document.getElementById('spend-val');
    const savingsVal = document.getElementById('savings-val');
    const bCurrent = document.getElementById('b-current');
    const bFee = document.getElementById('b-fee');
    const bNew = document.getElementById('b-new');

    if (spendInput) {
        spendInput.addEventListener('input', (e) => {
            const val = parseInt(e.target.value);
            const formatted = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(val);
            
            // Calculate savings (65%) and CloudPulse fee (2%)
            const savings = val * 0.65;
            const fee = val * 0.02;
            const newTotal = val - savings + fee;

            spendVal.innerText = formatted;
            bCurrent.innerText = formatted;
            
            savingsVal.innerText = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(savings);
            bFee.innerText = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(fee);
            bNew.innerText = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(newTotal);
        });
    }

    // 8. Use Cases Tab Switcher
    const tabs = document.querySelectorAll('.uc-tab');
    const panes = document.querySelectorAll('.uc-pane');

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active'));
            panes.forEach(p => p.classList.remove('active'));
            
            tab.classList.add('active');
            const target = document.getElementById(`uc-${tab.dataset.tab}`);
            if(target) target.classList.add('active');
        });
    });

    // 9. Pricing Toggle
    const billingSwitch = document.getElementById('billing-switch');
    const priceVals = document.querySelectorAll('.price-val');
    const btMonth = document.querySelector('.bt-label.month');
    const btAnnual = document.querySelector('.bt-label.annual');

    if (billingSwitch) {
        billingSwitch.addEventListener('change', (e) => {
            const isAnnual = e.target.checked;
            
            if(isAnnual) {
                btAnnual.classList.add('active');
                btMonth.classList.remove('active');
            } else {
                btMonth.classList.add('active');
                btAnnual.classList.remove('active');
            }

            // Animate prices on toggle
            priceVals.forEach(price => {
                price.style.transition = 'opacity 0.2s ease';
                price.style.opacity = '0';
                setTimeout(() => {
                    price.innerText = isAnnual ? price.dataset.annual : price.dataset.monthly;
                    price.style.opacity = '1';
                }, 200);
            });
        });
    }

    // 10. Before/After Slider Logic
    const baSlider = document.getElementById('ba-slider');
    if (baSlider) {
        baSlider.addEventListener('input', (e) => {
            const sliderPos = e.target.value;
            const baBefore = document.querySelector('.ba-before');
            const baLine = document.getElementById('ba-line');
            const baBtn = document.getElementById('ba-btn');
            
            // Adjust the clip path. e.g. at 50%, right inset is 50%
            baBefore.style.clipPath = `inset(0 ${100 - sliderPos}% 0 0)`;
            baLine.style.left = `${sliderPos}%`;
            baBtn.style.left = `${sliderPos}%`;
        });
    }

    // Performance: Only run heavy logic if page is visible
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === 'hidden') {
            // Optional: pause rendering/chart animations
        } else {
            // Optional: resume rendering/chart animations
        }
    });

    // Console branding
    console.log('%c☁️ CloudPulse AI Landing Page initialized successfully.', 'color: #3b82f6; font-size: 14px; font-weight: bold;');
});
