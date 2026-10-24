// A jQuery-era page: document ready, delegated events, $.getJSON ($.ajax over XMLHttpRequest), form handling, animation.
$(function () {
  $('header.top a').each(function () {
    var path = location.pathname;
    var href = $(this).attr('href');
    if (href === path || (href !== '/' && path.indexOf(href) === 0)) $(this).addClass('active');
  });

  // Home: a counter and an animated panel
  $('#inc').on('click', function () {
    $('#count').text(Number($('#count').text()) + 1);
  });
  $('#toggle').on('click', function () {
    $('#panel').slideToggle(40, function () { $('#panel-state').text($('#panel').is(':visible') ? 'open' : 'closed'); });
  });

  // Items: fetched list, filter, form
  if ($('#items').length) {
    var items = [];
    var render = function () {
      var needle = $('#filter').val().toLowerCase();
      var $list = $('#items').empty();
      $.each(items, function (_, item) {
        if ((item.title + ' ' + item.tag).toLowerCase().indexOf(needle) < 0) return;
        $('<li>').append($('<a>', { href: '/items/' + item.id + '/', text: item.title })).append($('<span>', { 'class': 'tag', text: item.tag })).appendTo($list);
      });
    };
    $.getJSON('/data/items.json').done(function (data) {
      items = data.items;
      $('#status').text('loaded ' + items.length);
      render();
    }).fail(function (xhr, status) {
      $('#status').text('failed: ' + status);
    });
    $('#filter').on('input', render);
    $('#add-form').on('submit', function (e) {
      e.preventDefault();
      var title = $.trim($('#new-item').val());
      if (!title) { $('#error').text('Title is required'); return; }
      $('#error').text('');
      items.push({ id: items.length + 1, title: title, tag: 'new' });
      $('#new-item').val('');
      render();
    });
  }
});
