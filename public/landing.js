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
    const faqItems = document.querySelectorAll('.faq-luxe-item');
    faqItems.forEach(item => {
        const header = item.querySelector('.faq-luxe-header');
        header.addEventListener('click', () => {
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
    const co2Val = document.getElementById('co2-val');

    if (spendInput) {
        spendInput.addEventListener('input', (e) => {
            const val = parseInt(e.target.value);
            const formatted = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(val);
            
            // Calculate savings (65%) and CloudPulse fee (2%)
            const savings = val * 0.65;
            const fee = val * 0.02;
            const newTotal = val - savings + fee;
            
            // CO2 math approx: 1kg per $1300 savings
            const co2 = (savings / 1300).toFixed(1);

            spendVal.innerText = formatted;
            bCurrent.innerText = formatted;
            
            savingsVal.innerText = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(savings);
            bFee.innerText = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(fee);
            bNew.innerText = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(newTotal);
            
            if (co2Val) {
                co2Val.innerText = `Prevent ~${co2} kg of CO₂ emissions monthly`;
            }
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

    // 10. Hologram Simulation Demo Logic
    const htLegacy = document.getElementById('ht-legacy');
    const htAi = document.getElementById('ht-ai');
    const holoTrigger = document.getElementById('holo-trigger');
    const tFill = document.getElementById('traffic-fill');
    const hAlert = document.getElementById('holo-alert');
    const aiNodes = document.querySelectorAll('.ai-node');
    const baseNodes = document.querySelectorAll('.base-node');

    if (htLegacy && htAi && holoTrigger) {
        let currentSimMode = 'legacy';
        let isSimRunning = false;

        const resetSim = () => {
            tFill.style.width = '15%';
            tFill.style.background = 'var(--accent-secondary)';
            hAlert.innerText = 'SYSTEM STABLE';
            hAlert.style.color = '#3b82f6';
            document.querySelector('.holo-display').classList.remove('spike-warning');
            
            baseNodes.forEach(node => node.classList.remove('spike-crash', 'shake'));
            aiNodes.forEach(node => node.classList.remove('node-spawn'));
        };

        htLegacy.addEventListener('click', () => {
            if(isSimRunning) return;
            htLegacy.classList.add('active');
            htAi.classList.remove('active');
            currentSimMode = 'legacy';
            resetSim();
        });

        htAi.addEventListener('click', () => {
            if(isSimRunning) return;
            htAi.classList.add('active');
            htLegacy.classList.remove('active');
            currentSimMode = 'ai';
            resetSim();
        });

        holoTrigger.addEventListener('click', () => {
            if (isSimRunning) return;
            isSimRunning = true;
            holoTrigger.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Simulating...';
            holoTrigger.style.pointerEvents = 'none';

            resetSim();

            // 1. Initial Traffic Pulse
            setTimeout(() => {
                tFill.style.width = '45%';
            }, 300);

            // 2. Traffic Spike Arrives
            setTimeout(() => {
                tFill.style.width = '100%';
                document.querySelector('.holo-display').classList.add('spike-warning');
                
                if (currentSimMode === 'legacy') {
                    // Legacy crashes immediately
                    setTimeout(() => {
                        hAlert.innerText = '100% CPU - SYSTEM OVERLOAD';
                        hAlert.style.color = '#ef4444';
                        baseNodes.forEach(node => node.classList.add('shake', 'spike-crash'));
                        
                        setTimeout(finalizeSim, 2000);
                    }, 500);

                } else {
                    // AI triggers predictive scale just before the peak crashes it
                    setTimeout(() => {
                        hAlert.innerText = 'PREDICTIVE SCALE ENGAGED';
                        hAlert.style.color = '#10b981';
                        
                        // Spawn nodes one by one
                        aiNodes.forEach((node, index) => {
                            setTimeout(() => {
                                node.classList.add('node-spawn');
                            }, index * 150);
                        });

                        // Nodes boot up and absorb load
                        setTimeout(() => {
                            document.querySelector('.holo-display').classList.remove('spike-warning');
                            tFill.style.background = '#10b981'; // Green stable
                            tFill.style.width = '35%'; // Load distributed
                            hAlert.innerText = 'TRAFFIC DISTRIBUTED - STABLE';
                            
                            setTimeout(finalizeSim, 2000);
                        }, 800);
                        
                    }, 200);
                }
            }, 1000);
        });

        function finalizeSim() {
            isSimRunning = false;
            holoTrigger.innerHTML = '<i class="fa-solid fa-bolt text-gradient"></i> Send Traffic';
            holoTrigger.style.pointerEvents = 'auto';
            
            // Revert nicely after delay
            setTimeout(() => {
                if(!isSimRunning) resetSim();
            }, 4000);
        }
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
