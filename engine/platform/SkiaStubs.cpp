// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// Skia's GPU entry points that LibGfx and the Compositor's player reference but never reach with no
// backend context (Ganglion's Skia is CPU raster only, tools/deps/skia.sh). They exist so the link has no
// undefined symbols that would otherwise become wasm imports.

#include <AK/Assertions.h>
#include <core/SkSurface.h>
#include <gpu/ganesh/GrDirectContext.h>
#include <gpu/ganesh/SkImageGanesh.h>
#include <gpu/ganesh/SkSurfaceGanesh.h>

sk_sp<SkImage> SkImages::TextureFromImage(GrDirectContext*, SkImage const*, skgpu::Mipmapped, skgpu::Budgeted)
{
    VERIFY_NOT_REACHED();
}

sk_sp<SkImage> SkImages::TextureFromYUVAPixmaps(GrRecordingContext*, SkYUVAPixmaps const&, skgpu::Mipmapped, bool, sk_sp<SkColorSpace>)
{
    VERIFY_NOT_REACHED();
}

sk_sp<SkSurface> SkSurfaces::RenderTarget(GrRecordingContext*, skgpu::Budgeted, SkImageInfo const&, int, GrSurfaceOrigin, SkSurfaceProps const*, bool, bool)
{
    VERIFY_NOT_REACHED();
}

GrSemaphoresSubmitted GrDirectContext::flush(SkSurface*, SkSurfaces::BackendSurfaceAccess, GrFlushInfo const&)
{
    VERIFY_NOT_REACHED();
}

bool GrDirectContext::submit(GrSubmitInfo const&)
{
    VERIFY_NOT_REACHED();
}

void GrDirectContext::performDeferredCleanup(std::chrono::milliseconds, GrPurgeResourceOptions)
{
    VERIFY_NOT_REACHED();
}

void GrDirectContext::getResourceCacheUsage(int*, size_t*) const
{
    VERIFY_NOT_REACHED();
}

void GrDirectContext::purgeUnlockedResources(GrPurgeResourceOptions)
{
    VERIFY_NOT_REACHED();
}
