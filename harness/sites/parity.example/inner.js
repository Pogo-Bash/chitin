onmessage = (e) => postMessage([e.data * 2, self.name, location.pathname.split('/').pop()].join(','));
